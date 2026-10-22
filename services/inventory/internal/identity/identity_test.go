package identity_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rizkyr99/sagamart/services/inventory/internal/identity"
)

var now = time.Date(2026, 10, 22, 3, 0, 0, 0, time.UTC)

// signer builds tokens like the gateway's, with any part overridable to test one rule at a time.
type signer struct {
	priv ed25519.PrivateKey
	kid  string
}

func newSigner(t *testing.T) (signer, map[string]string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return signer{priv: priv, kid: "gw-1"}, map[string]string{"gw-1": base64.StdEncoding.EncodeToString(der)}
}

func b64(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func (s signer) sign(header, claims map[string]any) string {
	input := b64(header) + "." + b64(claims)
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(s.priv, []byte(input)))
}

func (s signer) header() map[string]any {
	return map[string]any{"alg": "EdDSA", "typ": "sagamart-identity+jwt", "kid": s.kid}
}

func claims(roles ...string) map[string]any {
	return map[string]any{
		"iss": "gateway", "aud": "inventory", "sub": "0199f2e0-0000-7000-8000-000000000001",
		"roles": append([]string{}, roles...), "iat": now.Unix(), "exp": now.Unix() + 60, "jti": "0199f2e0-55aa-7bbb-8ccc-000000000042",
	}
}

func with(base map[string]any, key string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	if value == nil {
		delete(out, key)
	} else {
		out[key] = value
	}
	return out
}

func verifier(t *testing.T, keys map[string]string, at time.Time) *identity.Verifier {
	t.Helper()
	v, err := identity.NewVerifier(keys, "inventory")
	if err != nil {
		t.Fatal(err)
	}
	v.Now = func() time.Time { return at }
	return v
}

func TestVerifyAcceptsAValidToken(t *testing.T) {
	s, keys := newSigner(t)
	got, err := verifier(t, keys, now).Verify(s.sign(s.header(), claims("admin")))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Subject != "0199f2e0-0000-7000-8000-000000000001" || !got.HasRole("admin") || got.HasRole("buyer") {
		t.Fatalf("claims = %+v", got)
	}
}

func TestVerifyAcceptsAGuestWithoutSubject(t *testing.T) {
	s, keys := newSigner(t)
	got, err := verifier(t, keys, now).Verify(s.sign(s.header(), with(claims(), "sub", nil)))
	if err != nil || got.Subject != "" || len(got.Roles) != 0 {
		t.Fatalf("got %+v, %v", got, err)
	}
}

// TestVerifyAcceptsTheGatewaysTokens checks interoperability: the fixture was signed by node-common's signIdentity.
func TestVerifyAcceptsTheGatewaysTokens(t *testing.T) {
	raw, err := os.ReadFile("testdata/gateway-token.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct{ Kid, PublicKey, SignedAt, Token string }
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	at, err := time.Parse(time.RFC3339, fx.SignedAt)
	if err != nil {
		t.Fatal(err)
	}
	got, err := verifier(t, map[string]string{fx.Kid: fx.PublicKey}, at.Add(10*time.Second)).Verify(fx.Token)
	if err != nil {
		t.Fatalf("Verify(gateway token): %v", err)
	}
	if !got.HasRole("admin") {
		t.Fatalf("roles = %v", got.Roles)
	}
}

func TestVerifySkew(t *testing.T) {
	s, keys := newSigner(t)
	token := s.sign(s.header(), claims("admin"))
	for name, tc := range map[string]struct {
		at     time.Time
		reason identity.Reason
	}{
		"4 s before iat": {now.Add(-4 * time.Second), ""},
		"6 s before iat": {now.Add(-6 * time.Second), identity.ReasonNotYetValid},
		"4 s after exp":  {now.Add(64 * time.Second), ""},
		"6 s after exp":  {now.Add(66 * time.Second), identity.ReasonExpired},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := verifier(t, keys, tc.at).Verify(token)
			if tc.reason == "" {
				if err != nil {
					t.Fatalf("Verify: %v", err)
				}
				return
			}
			assertReason(t, err, tc.reason)
		})
	}
}

func TestVerifyRejects(t *testing.T) {
	s, keys := newSigner(t)
	other, _ := newSigner(t)
	valid := s.sign(s.header(), claims("admin"))
	parts := strings.Split(valid, ".")

	cases := map[string]struct {
		token  string
		reason identity.Reason
	}{
		"an empty token":               {"", identity.ReasonMalformed},
		"two parts":                    {parts[0] + "." + parts[1], identity.ReasonMalformed},
		"a header that is not JSON":    {"bm90LWpzb24." + parts[1] + "." + parts[2], identity.ReasonMalformed},
		"alg none":                     {s.sign(with(s.header(), "alg", "none"), claims("admin")), identity.ReasonBadHeader},
		"alg HS256":                    {s.sign(with(s.header(), "alg", "HS256"), claims("admin")), identity.ReasonBadHeader},
		"another typ":                  {s.sign(with(s.header(), "typ", "JWT"), claims("admin")), identity.ReasonBadHeader},
		"an unknown kid":               {s.sign(with(s.header(), "kid", "gw-9"), claims("admin")), identity.ReasonUnknownKey},
		"another key's signature":      {other.sign(s.header(), claims("admin")), identity.ReasonBadSignature},
		"tampered claims":              {parts[0] + "." + b64(claims("admin", "buyer")) + "." + parts[2], identity.ReasonBadSignature},
		"another issuer":               {s.sign(s.header(), with(claims("admin"), "iss", "someone")), identity.ReasonBadClaims},
		"another audience":             {s.sign(s.header(), with(claims("admin"), "aud", "catalog")), identity.ReasonBadClaims},
		"no exp":                       {s.sign(s.header(), with(claims("admin"), "exp", nil)), identity.ReasonBadClaims},
		"a subject that is not a UUID": {s.sign(s.header(), with(claims("admin"), "sub", "admin")), identity.ReasonBadClaims},
		"roles that are not strings":   {s.sign(s.header(), with(claims(), "roles", []any{1})), identity.ReasonBadClaims},
		"null roles":                   {s.sign(s.header(), with(claims(), "roles", json.RawMessage("null"))), identity.ReasonBadClaims},
		"roles that are not a list":    {s.sign(s.header(), with(claims(), "roles", "admin")), identity.ReasonBadClaims},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := verifier(t, keys, now).Verify(tc.token)
			assertReason(t, err, tc.reason)
		})
	}
}

func TestNewVerifierRejectsBadKeys(t *testing.T) {
	for name, keys := range map[string]map[string]string{
		"no keys":       {},
		"not base64":    {"k": "!!!"},
		"not a DER key": {"k": base64.StdEncoding.EncodeToString([]byte("nope"))},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := identity.NewVerifier(keys, "inventory"); err == nil {
				t.Fatal("NewVerifier accepted bad keys")
			}
		})
	}
}

func assertReason(t *testing.T, err error, want identity.Reason) {
	t.Helper()
	var verr *identity.Error
	if !errors.As(err, &verr) {
		t.Fatalf("err = %v, want an *identity.Error with reason %s", err, want)
	}
	if verr.Reason != want {
		t.Fatalf("reason = %s, want %s", verr.Reason, want)
	}
}
