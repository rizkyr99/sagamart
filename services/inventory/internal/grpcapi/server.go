// Package grpcapi implements sagamart.inventory.v1.InventoryService on top of the store: it translates
// requests into domain types, and domain errors into gRPC status codes with ErrorInfo details.
package grpcapi

import (
	"context"
	"log/slog"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

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

	store  Store
	limits domain.Limits
	log    *slog.Logger
}

// New returns a Server.
func New(store Store, limits domain.Limits, log *slog.Logger) *Server {
	return &Server{store: store, limits: limits, log: log}
}

func (s *Server) ReserveStock(ctx context.Context, req *inventoryv1.ReserveStockRequest) (*inventoryv1.ReserveStockResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func (s *Server) CommitReservation(ctx context.Context, req *inventoryv1.CommitReservationRequest) (*inventoryv1.CommitReservationResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func (s *Server) ReleaseReservation(ctx context.Context, req *inventoryv1.ReleaseReservationRequest) (*inventoryv1.ReleaseReservationResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func (s *Server) GetStockLevels(ctx context.Context, req *inventoryv1.GetStockLevelsRequest) (*inventoryv1.GetStockLevelsResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func (s *Server) SetStockLevel(ctx context.Context, req *inventoryv1.SetStockLevelRequest) (*inventoryv1.SetStockLevelResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not implemented")
}
