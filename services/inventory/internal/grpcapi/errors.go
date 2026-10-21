package grpcapi

import (
	"context"
	"errors"
	"math"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/protoadapt"

	inventoryv1 "github.com/rizkyr99/sagamart/contracts/gen/go/sagamart/inventory/v1"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
)

// reasons maps domain errors to their status code and ErrorInfo reason (inventory contract).
var reasons = []struct {
	err    error
	code   codes.Code
	reason string
}{
	{domain.ErrReservationNotFound, codes.NotFound, "RESERVATION_NOT_FOUND"},
	{domain.ErrReservationCommitted, codes.FailedPrecondition, "RESERVATION_COMMITTED"},
	{domain.ErrReservationConflict, codes.AlreadyExists, "RESERVATION_CONFLICT"},
	{domain.ErrStockBelowReserved, codes.FailedPrecondition, "STOCK_BELOW_RESERVED"},
	{domain.ErrVersionConflict, codes.Aborted, "VERSION_CONFLICT"},
}

// toStatus converts an error from the domain or store into a gRPC status. The second result is false for
// errors the caller can do nothing about (internal errors), which the handler logs.
func toStatus(ctx context.Context, err error) (error, bool) {
	var verr *domain.ValidationError
	var serr *domain.InsufficientStockError
	switch {
	case errors.As(err, &verr):
		br := &errdetails.BadRequest{}
		for _, v := range verr.Violations {
			br.FieldViolations = append(br.FieldViolations, &errdetails.BadRequest_FieldViolation{Field: v.Field, Description: v.Description})
		}
		return withDetails(codes.InvalidArgument, verr.Error(), br), true

	case errors.As(err, &serr):
		detail := &inventoryv1.InsufficientStockDetail{}
		for _, sf := range serr.Shortfalls {
			detail.Shortfalls = append(detail.Shortfalls, &inventoryv1.StockShortfall{
				// Requested is bounded by the per-line cap, far below the int32 range.
				Sku: sf.SKU, Requested: int32(min(sf.Requested, math.MaxInt32)), Available: sf.Available, //nolint:gosec // G115: clamped above
			})
		}
		return withDetails(codes.FailedPrecondition, serr.Error(), errorInfo("INSUFFICIENT_STOCK"), detail), true

	case errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded):
		return status.Error(codes.DeadlineExceeded, "deadline exceeded"), true
	case errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled):
		return status.Error(codes.Canceled, "canceled"), true
	}

	for _, r := range reasons {
		if errors.Is(err, r.err) {
			return withDetails(r.code, err.Error(), errorInfo(r.reason)), true
		}
	}
	// Database and invariant errors: log them, never send their text to the caller.
	return status.Error(codes.Internal, "internal error"), false
}

func errorInfo(reason string) *errdetails.ErrorInfo {
	return &errdetails.ErrorInfo{Reason: reason, Domain: ErrorDomain}
}

func withDetails(code codes.Code, msg string, details ...protoadapt.MessageV1) error {
	st, err := status.New(code, msg).WithDetails(details...)
	if err != nil {
		return status.Error(code, msg)
	}
	return st.Err()
}
