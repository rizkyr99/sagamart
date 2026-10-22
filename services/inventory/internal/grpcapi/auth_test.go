package grpcapi_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	inventoryv1 "github.com/rizkyr99/sagamart/contracts/gen/go/sagamart/inventory/v1"

	"github.com/rizkyr99/sagamart/services/inventory/internal/grpcapi"
	"github.com/rizkyr99/sagamart/services/inventory/internal/identity"
)

// gatewayKey signs identities as the gateway does (contracts/identity.md).
type gatewayKey struct{ priv ed25519.PrivateKey }

func newGateway(t *testing.T) (gatewayKey, *identity.Verifier) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	v, err := identity.NewVerifier(map[string]string{"gw-1": base64.StdEncoding.EncodeToString(der)}, "inventory")
	if err != nil {
		t.Fatal(err)
	}
	return gatewayKey{priv: priv}, v
}

func (g gatewayKey) token(audience string, roles ...string) string {
	enc := func(v any) string {
		raw, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	now := time.Now().Unix()
	input := enc(map[string]any{"alg": "EdDSA", "typ": "sagamart-identity+jwt", "kid": "gw-1"}) + "." +
		enc(map[string]any{"iss": "gateway", "aud": audience, "sub": "0199f2e0-0000-7000-8000-00000000a001",
			"roles": append([]string{}, roles...), "iat": now, "exp": now + 60, "jti": "j"})
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(g.priv, []byte(input)))
}

func call(t *testing.T, v *identity.Verifier, method, token string) (bool, error) {
	t.Helper()
	ctx := context.Background()
	if token != "" {
		ctx = metadata.NewIncomingContext(ctx, metadata.Pairs(identity.Header, token))
	}
	reached := false
	handler := func(context.Context, any) (any, error) {
		reached = true
		return "ok", nil
	}
	_, err := grpcapi.IdentityInterceptor(v, slog.New(slog.DiscardHandler))(
		ctx, nil, &grpc.UnaryServerInfo{FullMethod: method}, handler)
	return reached, err
}

func assertDenied(t *testing.T, reached bool, err error, code codes.Code, reason string) {
	t.Helper()
	if reached {
		t.Fatal("the handler ran for a denied call")
	}
	st := status.Convert(err)
	if st.Code() != code {
		t.Fatalf("code = %v, want %v (%v)", st.Code(), code, err)
	}
	for _, d := range st.Details() {
		if info, ok := d.(*errdetails.ErrorInfo); ok && info.GetReason() == reason {
			return
		}
	}
	t.Fatalf("no ErrorInfo with reason %s in %v", reason, st.Details())
}

func TestSetStockLevelRequiresAnAdminIdentity(t *testing.T) {
	gw, v := newGateway(t)
	set := inventoryv1.InventoryService_SetStockLevel_FullMethodName

	t.Run("missing", func(t *testing.T) {
		reached, err := call(t, v, set, "")
		assertDenied(t, reached, err, codes.Unauthenticated, "UNAUTHENTICATED")
	})
	t.Run("invalid", func(t *testing.T) {
		reached, err := call(t, v, set, "not-a-token")
		assertDenied(t, reached, err, codes.Unauthenticated, "UNAUTHENTICATED")
	})
	t.Run("for another service", func(t *testing.T) {
		reached, err := call(t, v, set, gw.token("catalog", "admin"))
		assertDenied(t, reached, err, codes.Unauthenticated, "UNAUTHENTICATED")
	})
	t.Run("a buyer", func(t *testing.T) {
		reached, err := call(t, v, set, gw.token("inventory", "buyer"))
		assertDenied(t, reached, err, codes.PermissionDenied, "PERMISSION_DENIED")
	})
	t.Run("an admin", func(t *testing.T) {
		reached, err := call(t, v, set, gw.token("inventory", "admin"))
		if err != nil || !reached {
			t.Fatalf("reached = %v, err = %v", reached, err)
		}
	})
}

// Browsing calls come through the gateway, which always signs an identity, guests included (contracts/identity.md).
func TestGetStockLevelsRequiresAnyValidIdentity(t *testing.T) {
	gw, v := newGateway(t)
	get := inventoryv1.InventoryService_GetStockLevels_FullMethodName

	reached, err := call(t, v, get, "")
	assertDenied(t, reached, err, codes.Unauthenticated, "UNAUTHENTICATED")
	for _, roles := range [][]string{{}, {"buyer"}, {"admin"}} {
		if reached, err := call(t, v, get, gw.token("inventory", roles...)); err != nil || !reached {
			t.Fatalf("roles %v: reached = %v, err = %v", roles, reached, err)
		}
	}
}

// The saga RPCs get Order's service identity in RFC-0002; until then they, and gRPC health, are unaffected.
func TestSagaAndHealthCallsAreUnaffected(t *testing.T) {
	_, v := newGateway(t)
	for _, method := range []string{
		inventoryv1.InventoryService_ReserveStock_FullMethodName,
		inventoryv1.InventoryService_CommitReservation_FullMethodName,
		inventoryv1.InventoryService_ReleaseReservation_FullMethodName,
		"/grpc.health.v1.Health/Check",
	} {
		t.Run(method, func(t *testing.T) {
			if reached, err := call(t, v, method, ""); err != nil || !reached {
				t.Fatalf("reached = %v, err = %v", reached, err)
			}
		})
	}
}
