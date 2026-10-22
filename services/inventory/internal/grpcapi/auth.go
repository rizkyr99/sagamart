package grpcapi

import (
	"context"
	"errors"
	"log/slog"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"

	inventoryv1 "github.com/rizkyr99/sagamart/contracts/gen/go/sagamart/inventory/v1"

	"github.com/rizkyr99/sagamart/services/inventory/internal/identity"
)

// requiredRole lists the RPCs the gateway calls, and the role each needs ("" for any valid identity), per
// contracts/identity.md. The saga RPCs will require Order's service identity, defined in RFC-0002.
var requiredRole = map[string]string{
	inventoryv1.InventoryService_GetStockLevels_FullMethodName: "",
	inventoryv1.InventoryService_SetStockLevel_FullMethodName:  "admin",
}

// IdentityInterceptor verifies x-sagamart-identity on the RPCs in requiredRole and checks the role: a missing or
// invalid identity is UNAUTHENTICATED, a missing role PERMISSION_DENIED. The token is never logged.
func IdentityInterceptor(v *identity.Verifier, log *slog.Logger) grpc.UnaryServerInterceptor {
	rejections, err := otel.Meter(meterName).Int64Counter("sagamart.inventory.identity_rejections",
		metric.WithDescription("Calls refused by identity verification, by reason."))
	if err != nil {
		otel.Handle(err)
	}
	deny := func(ctx context.Context, method string, reason identity.Reason, code codes.Code) error {
		rejections.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", string(reason))))
		log.WarnContext(ctx, "identity rejected", "method", method, "reason", string(reason))
		if code == codes.PermissionDenied {
			return withDetails(code, "requires the admin role", errorInfo("PERMISSION_DENIED"))
		}
		return withDetails(code, "a valid gateway identity is required", errorInfo("UNAUTHENTICATED"))
	}

	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		role, protected := requiredRole[info.FullMethod]
		if !protected {
			return handler(ctx, req)
		}
		values := metadata.ValueFromIncomingContext(ctx, identity.Header)
		if len(values) != 1 || values[0] == "" {
			return nil, deny(ctx, info.FullMethod, identity.ReasonMissing, codes.Unauthenticated)
		}
		claims, err := v.Verify(values[0])
		if err != nil {
			reason := identity.ReasonMalformed
			var verr *identity.Error
			if errors.As(err, &verr) {
				reason = verr.Reason
			}
			return nil, deny(ctx, info.FullMethod, reason, codes.Unauthenticated)
		}
		if role != "" && !claims.HasRole(role) {
			return nil, deny(ctx, info.FullMethod, identity.ReasonMissingRole, codes.PermissionDenied)
		}
		return handler(ctx, req)
	}
}
