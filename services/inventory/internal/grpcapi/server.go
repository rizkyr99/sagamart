// Package grpcapi implements sagamart.inventory.v1.InventoryService on top of the store: it translates
// requests into domain types, and domain errors into gRPC status codes with ErrorInfo details.
package grpcapi

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	inventoryv1 "github.com/rizkyr99/sagamart/contracts/gen/go/sagamart/inventory/v1"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
)

// ErrorDomain is the ErrorInfo domain on every Inventory error (inventory contract).
const ErrorDomain = "inventory.sagamart.dev"

// Store is the persistence the API needs; *store.Store implements it.
type Store interface {
	Reserve(ctx context.Context, req domain.ReserveRequest) (domain.Reservation, error)
	Commit(ctx context.Context, orderID string) (time.Time, error)
	Release(ctx context.Context, orderID string) (domain.Status, error)
	StockLevels(ctx context.Context, skus []string) ([]domain.StockLevel, error)
	SetStock(ctx context.Context, sku string, onHand, expectedVersion int64) (domain.StockLevel, error)
}

// Server is the InventoryService implementation.
type Server struct {
	inventoryv1.UnimplementedInventoryServiceServer

	store   Store
	limits  domain.Limits
	log     *slog.Logger
	metrics metrics
}

// New returns a Server.
// TODO(#17): SetStockLevel must check the admin role from the gateway's signed identity header (RFC-0001 §8).
func New(store Store, limits domain.Limits, log *slog.Logger) *Server {
	return &Server{store: store, limits: limits, log: log, metrics: newMetrics()}
}

func (s *Server) ReserveStock(ctx context.Context, req *inventoryv1.ReserveStockRequest) (*inventoryv1.ReserveStockResponse, error) {
	start := time.Now()
	res, err := s.reserve(ctx, req)
	s.metrics.recordReservation(ctx, reservationResult(err), time.Since(start).Seconds())
	if err != nil {
		return nil, s.fail(ctx, "ReserveStock", err, "order_id", req.GetOrderId())
	}
	s.log.InfoContext(ctx, "stock reserved", "order_id", res.OrderID, "reservation_id", res.ID, "lines", len(res.Lines))
	return &inventoryv1.ReserveStockResponse{ReservationId: res.ID, ExpiresAt: timestamppb.New(res.ExpiresAt)}, nil
}

func (s *Server) reserve(ctx context.Context, req *inventoryv1.ReserveStockRequest) (domain.Reservation, error) {
	var ttl time.Duration
	if req.GetTtl() != nil {
		if err := req.GetTtl().CheckValid(); err != nil {
			// Report every other problem too, as NormalizeReserve would.
			_, nerr := s.limits.NormalizeReserve(toReserveRequest(req, 0))
			violations := []domain.Violation{{Field: "ttl", Description: "not a valid duration"}}
			var verr *domain.ValidationError
			if errors.As(nerr, &verr) {
				violations = append(verr.Violations, violations...)
			}
			return domain.Reservation{}, &domain.ValidationError{Violations: violations}
		}
		ttl = req.GetTtl().AsDuration()
	}
	normalized, err := s.limits.NormalizeReserve(toReserveRequest(req, ttl))
	if err != nil {
		return domain.Reservation{}, err
	}
	return s.store.Reserve(ctx, normalized)
}

func toReserveRequest(req *inventoryv1.ReserveStockRequest, ttl time.Duration) domain.ReserveRequest {
	lines := make([]domain.Line, len(req.GetLines()))
	for i, l := range req.GetLines() {
		lines[i] = domain.Line{SKU: l.GetSku(), Quantity: int64(l.GetQuantity())}
	}
	return domain.ReserveRequest{OrderID: req.GetOrderId(), Lines: lines, TTL: ttl}
}

func reservationResult(err error) string {
	var verr *domain.ValidationError
	switch {
	case err == nil:
		return resultReserved
	case errors.Is(err, domain.ErrInsufficientStock):
		return resultInsufficientStock
	case errors.Is(err, domain.ErrReservationConflict):
		return resultConflict
	case errors.As(err, &verr):
		return resultInvalid
	default:
		return resultError
	}
}

func (s *Server) CommitReservation(ctx context.Context, req *inventoryv1.CommitReservationRequest) (*inventoryv1.CommitReservationResponse, error) {
	if err := validateOrderID(req.GetOrderId()); err != nil {
		return nil, s.fail(ctx, "CommitReservation", err)
	}
	committedAt, err := s.store.Commit(ctx, req.GetOrderId())
	if err != nil {
		return nil, s.fail(ctx, "CommitReservation", err, "order_id", req.GetOrderId())
	}
	s.log.InfoContext(ctx, "reservation committed", "order_id", req.GetOrderId())
	return &inventoryv1.CommitReservationResponse{CommittedAt: timestamppb.New(committedAt)}, nil
}

func (s *Server) ReleaseReservation(ctx context.Context, req *inventoryv1.ReleaseReservationRequest) (*inventoryv1.ReleaseReservationResponse, error) {
	if err := validateOrderID(req.GetOrderId()); err != nil {
		return nil, s.fail(ctx, "ReleaseReservation", err)
	}
	status, err := s.store.Release(ctx, req.GetOrderId())
	if err != nil {
		return nil, s.fail(ctx, "ReleaseReservation", err, "order_id", req.GetOrderId())
	}
	s.log.InfoContext(ctx, "reservation released", "order_id", req.GetOrderId(), "status", string(status), "reason", req.GetReason().String())
	return &inventoryv1.ReleaseReservationResponse{Status: toProtoStatus(status)}, nil
}

func (s *Server) GetStockLevels(ctx context.Context, req *inventoryv1.GetStockLevelsRequest) (*inventoryv1.GetStockLevelsResponse, error) {
	if err := domain.ValidateStockQuery(req.GetSkus()); err != nil {
		return nil, s.fail(ctx, "GetStockLevels", err)
	}
	levels, err := s.store.StockLevels(ctx, req.GetSkus())
	if err != nil {
		return nil, s.fail(ctx, "GetStockLevels", err)
	}
	resp := &inventoryv1.GetStockLevelsResponse{Levels: make([]*inventoryv1.StockLevel, len(levels))}
	for i, l := range levels {
		resp.Levels[i] = toProtoLevel(l)
	}
	return resp, nil
}

func (s *Server) SetStockLevel(ctx context.Context, req *inventoryv1.SetStockLevelRequest) (*inventoryv1.SetStockLevelResponse, error) {
	level, err := s.store.SetStock(ctx, req.GetSku(), req.GetOnHand(), req.GetExpectedVersion())
	if err != nil {
		return nil, s.fail(ctx, "SetStockLevel", err, "sku", req.GetSku())
	}
	s.log.InfoContext(ctx, "stock level set", "sku", level.SKU, "on_hand", level.OnHand, "version", level.Version)
	return &inventoryv1.SetStockLevelResponse{Level: toProtoLevel(level)}, nil
}

// fail converts err to a gRPC status, logging errors the caller can't act on.
func (s *Server) fail(ctx context.Context, rpc string, err error, attrs ...any) error {
	st, expected := toStatus(ctx, err)
	if !expected {
		s.log.ErrorContext(ctx, "request failed", append([]any{"rpc", rpc, "error", err}, attrs...)...)
	}
	return st
}

func validateOrderID(id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return &domain.ValidationError{Violations: []domain.Violation{{Field: "order_id", Description: "must be a UUID"}}}
	}
	return nil
}

func toProtoLevel(l domain.StockLevel) *inventoryv1.StockLevel {
	return &inventoryv1.StockLevel{Sku: l.SKU, OnHand: l.OnHand, Reserved: l.Reserved, Available: l.Available(), Version: l.Version}
}

func toProtoStatus(s domain.Status) inventoryv1.ReservationStatus {
	switch s {
	case domain.StatusActive:
		return inventoryv1.ReservationStatus_RESERVATION_STATUS_ACTIVE
	case domain.StatusCommitted:
		return inventoryv1.ReservationStatus_RESERVATION_STATUS_COMMITTED
	case domain.StatusReleased:
		return inventoryv1.ReservationStatus_RESERVATION_STATUS_RELEASED
	case domain.StatusExpired:
		return inventoryv1.ReservationStatus_RESERVATION_STATUS_EXPIRED
	}
	return inventoryv1.ReservationStatus_RESERVATION_STATUS_UNSPECIFIED
}
