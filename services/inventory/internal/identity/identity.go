// Package identity verifies the gateway's signed internal identity, x-sagamart-identity (contracts/identity.md):
// a compact JWS signed with Ed25519 by the gateway alone, naming the caller's user ID and roles for one service.
package identity

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Header is the gRPC metadata key that carries the token.
const Header = "x-sagamart-identity"

const (
	issuer = "gateway"
	// tokenType distinguishes these tokens from any other JWT, so one can't be replayed as the other.
	tokenType = "sagamart-identity+jwt"
	skew      = 5 * time.Second
)

// Reason says why a token was rejected. It is logged and counted, never sent to the caller.
type Reason string

// Rejection reasons, the `reason` label on sagamart_inventory_identity_rejections_total.
const (
	ReasonMissing      Reason = "MISSING"
	ReasonMalformed    Reason = "MALFORMED"
	ReasonBadHeader    Reason = "BAD_HEADER"
	ReasonUnknownKey   Reason = "UNKNOWN_KEY"
	ReasonBadSignature Reason = "BAD_SIGNATURE"
	ReasonBadClaims    Reason = "BAD_CLAIMS"
	ReasonExpired      Reason = "EXPIRED"
	ReasonNotYetValid  Reason = "NOT_YET_VALID"
	// ReasonMissingRole is a valid identity without the role the operation needs.
	ReasonMissingRole Reason = "MISSING_ROLE"
)

// Error is a rejected token.
type Error struct{ Reason Reason }

func (e *Error) Error() string { return "identity rejected: " + string(e.Reason) }

func reject(r Reason) error { return &Error{Reason: r} }

// Claims are the verified caller. Subject is empty for guests and anonymous calls.
type Claims struct {
	Subject string
	Roles   []string
}

// HasRole reports whether the caller has role.
func (c Claims) HasRole(role string) bool { return slices.Contains(c.Roles, role) }

// Verifier checks tokens for one audience against the gateway public keys it trusts.
type Verifier struct {
	keys     map[string]ed25519.PublicKey
	audience string
	// Now is the clock; tests replace it.
	Now func() time.Time
}

// NewVerifier parses keys, a map of kid to SPKI DER (base64), as in <SERVICE>_IDENTITY_PUBLIC_KEYS.
func NewVerifier(keys map[string]string, audience string) (*Verifier, error) {
	if len(keys) == 0 {
		return nil, errors.New("at least one gateway public key is required")
	}
	v := &Verifier{keys: map[string]ed25519.PublicKey{}, audience: audience, Now: time.Now}
	for kid, b64 := range keys {
		der, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("key %q: not base64: %w", kid, err)
		}
		parsed, err := x509.ParsePKIXPublicKey(der)
		if err != nil {
			return nil, fmt.Errorf("key %q: %w", kid, err)
		}
		pub, ok := parsed.(ed25519.PublicKey)
		if !ok {
			return nil, fmt.Errorf("key %q: not an Ed25519 public key", kid)
		}
		v.keys[kid] = pub
	}
	return v, nil
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
	Kid string `json:"kid"`
}

type payload struct {
	Iss   string          `json:"iss"`
	Aud   string          `json:"aud"`
	Sub   *string         `json:"sub"`
	Roles json.RawMessage `json:"roles"`
	Iat   *int64          `json:"iat"`
	Exp   *int64          `json:"exp"`
}

func decodeSegment(segment string, into any) error {
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		return err
	}
	return json.NewDecoder(bytes.NewReader(raw)).Decode(into)
}

// Verify checks token as the contract requires, in order: shape, header (alg fixed to EdDSA, never taken from
// the token), signature by a trusted kid, issuer and audience, then time with 5 s of skew, then claim types.
func (v *Verifier) Verify(token string) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, reject(ReasonMalformed)
	}
	var h header
	if err := decodeSegment(parts[0], &h); err != nil {
		return Claims{}, reject(ReasonMalformed)
	}
	if h.Alg != "EdDSA" || h.Typ != tokenType {
		return Claims{}, reject(ReasonBadHeader)
	}
	key, ok := v.keys[h.Kid]
	if !ok {
		return Claims{}, reject(ReasonUnknownKey)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Claims{}, reject(ReasonMalformed)
	}
	if !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), sig) {
		return Claims{}, reject(ReasonBadSignature)
	}

	var p payload
	if err := decodeSegment(parts[1], &p); err != nil {
		return Claims{}, reject(ReasonMalformed)
	}
	if p.Iss != issuer || p.Aud != v.audience || p.Iat == nil || p.Exp == nil {
		return Claims{}, reject(ReasonBadClaims)
	}
	now := v.Now()
	if now.After(time.Unix(*p.Exp, 0).Add(skew)) {
		return Claims{}, reject(ReasonExpired)
	}
	if now.Add(skew).Before(time.Unix(*p.Iat, 0)) {
		return Claims{}, reject(ReasonNotYetValid)
	}
	var roles []string
	if err := json.Unmarshal(p.Roles, &roles); err != nil || roles == nil {
		return Claims{}, reject(ReasonBadClaims)
	}
	claims := Claims{Roles: roles}
	if p.Sub != nil {
		if !uuidPattern.MatchString(*p.Sub) {
			return Claims{}, reject(ReasonBadClaims)
		}
		claims.Subject = *p.Sub
	}
	return claims, nil
}
