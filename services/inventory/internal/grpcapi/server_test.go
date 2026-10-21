package grpcapi_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"testing"
	"time"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/types/known/durationpb"

	inventoryv1 "github.com/rizkyr99/sagamart/contracts/gen/go/sagamart/inventory/v1"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
	"github.com/rizkyr99/sagamart/services/inventory/internal/grpcapi"
)

const orderID = "0199f29e-8a10-7b2c-9d3e-4f5a6b7c8d9e"

// fakeStore records calls and returns canned results.
type fakeStore struct {
	reserveReq  domain.ReserveRequest
	reservation domain.Reservation
	committedAt time.Time
	released    domain.Status
	levels      []domain.StockLevel
	level       domain.StockLevel
	err         error
	block       bool // wait for the caller's context instead of answering
}

func (f *fakeStore) wait(ctx context.Context) error {
	if f.block {
		<-ctx.Done()
		return ctx.Err()
	}
	return f.err
}

func (f *fakeStore) Reserve(ctx context.Context, req domain.ReserveRequest) (domain.Reservation, error) {
	f.reserveReq = req
	return f.reservation, f.wait(ctx)
}

func (f *fakeStore) Commit(ctx context.Context, _ string) (time.Time, error) {
	return f.committedAt, f.wait(ctx)
}

func (f *fakeStore) Release(ctx context.Context, _ string) (domain.Status, error) {
	return f.released, f.wait(ctx)
}

func (f *fakeStore) StockLevels(ctx context.Context, _ []string) ([]domain.StockLevel, error) {
	return f.levels, f.wait(ctx)
}

func (f *fakeStore) SetStock(ctx context.Context, _ string, _, _ int64) (domain.StockLevel, error) {
	return f.level, f.wait(ctx)
}

// client serves the API over an in-memory connection so status codes and details cross a real gRPC boundary.
func client(t *testing.T, store grpcapi.Store) inventoryv1.InventoryServiceClient {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	inventoryv1.RegisterInventoryServiceServer(srv, grpcapi.New(store, domain.NewLimits(100), slog.New(slog.NewTextHandler(io.Discard, nil))))
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return inventoryv1.NewInventoryServiceClient(conn)
}

func ctx(t *testing.T) context.Context {
	t.Helper()
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return c
}

// details splits a status into its code, ErrorInfo reason and other details.
func details(t *testing.T, err error) (codes.Code, string, []any) {
	t.Helper()
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("not a gRPC status: %v", err)
	}
	reason := ""
	var rest []any
	for _, d := range st.Details() {
		if info, ok := d.(*errdetails.ErrorInfo); ok {
			if info.GetDomain() != grpcapi.ErrorDomain {
				t.Errorf("ErrorInfo domain = %q, want %q", info.GetDomain(), grpcapi.ErrorDomain)
			}
			reason = info.GetReason()
			continue
		}
		rest = append(rest, d)
	}
	return st.Code(), reason, rest
}

func TestReserveStock(t *testing.T) {
	expires := time.Date(2026, 10, 21, 3, 10, 0, 0, time.UTC)
	store := &fakeStore{reservation: domain.Reservation{ID: "0199f29e-8b22-7c31-a4d5-6e7f8091a2b3", ExpiresAt: expires}}

	resp, err := client(t, store).ReserveStock(ctx(t), &inventoryv1.ReserveStockRequest{
		OrderId: orderID,
		Lines:   []*inventoryv1.ReservationLine{{Sku: "KAOS-002", Quantity: 1}, {Sku: "BAJU-001", Quantity: 2}},
	})
	if err != nil {
		t.Fatalf("ReserveStock: %v", err)
	}
	if resp.GetReservationId() != store.reservation.ID || !resp.GetExpiresAt().AsTime().Equal(expires) {
		t.Errorf("response = %v", resp)
	}

	got := store.reserveReq
	if got.OrderID != orderID || got.TTL != 10*time.Minute {
		t.Errorf("store got %+v, want the default 10m TTL", got)
	}
	if len(got.Lines) != 2 || got.Lines[0].SKU != "BAJU-001" || got.Lines[1] != (domain.Line{SKU: "KAOS-002", Quantity: 1}) {
		t.Errorf("store got lines %+v, want them normalized (sorted by SKU)", got.Lines)
	}
}

func TestReserveStockPassesTTL(t *testing.T) {
	store := &fakeStore{}
	_, err := client(t, store).ReserveStock(ctx(t), &inventoryv1.ReserveStockRequest{
		OrderId: orderID, Lines: []*inventoryv1.ReservationLine{{Sku: "KAOS-001", Quantity: 1}}, Ttl: durationpb.New(3 * time.Minute),
	})
	if err != nil || store.reserveReq.TTL != 3*time.Minute {
		t.Errorf("TTL = %v, err %v; want 3m", store.reserveReq.TTL, err)
	}
}

func TestReserveStockRejectsInvalidRequest(t *testing.T) {
	store := &fakeStore{}
	_, err := client(t, store).ReserveStock(ctx(t), &inventoryv1.ReserveStockRequest{
		OrderId: "not-a-uuid",
		Lines:   []*inventoryv1.ReservationLine{{Sku: "KAOS-001", Quantity: 0}},
		Ttl:     &durationpb.Duration{Seconds: 1, Nanos: -1},
	})

	code, _, rest := details(t, err)
	if code != codes.InvalidArgument {
		t.Fatalf("code = %v, want InvalidArgument", code)
	}
	fields := map[string]bool{}
	for _, d := range rest {
		if br, ok := d.(*errdetails.BadRequest); ok {
			for _, v := range br.GetFieldViolations() {
				fields[v.GetField()] = true
			}
		}
	}
	for _, want := range []string{"order_id", "lines[0].quantity", "ttl"} {
		if !fields[want] {
			t.Errorf("BadRequest lacks %s: %v", want, fields)
		}
	}
	if store.reserveReq.OrderID != "" {
		t.Error("an invalid request reached the store")
	}
}

func TestReserveStockInsufficientStock(t *testing.T) {
	store := &fakeStore{err: &domain.InsufficientStockError{Shortfalls: []domain.Shortfall{
		{SKU: "KAOS-001", Requested: 5, Available: 2},
		{SKU: "TOPI-001", Requested: 1, Available: 0},
	}}}
	_, err := client(t, store).ReserveStock(ctx(t), &inventoryv1.ReserveStockRequest{
		OrderId: orderID,
		Lines:   []*inventoryv1.ReservationLine{{Sku: "KAOS-001", Quantity: 5}, {Sku: "TOPI-001", Quantity: 1}},
	})

	code, reason, rest := details(t, err)
	if code != codes.FailedPrecondition || reason != "INSUFFICIENT_STOCK" {
		t.Fatalf("got %v / %q, want FailedPrecondition / INSUFFICIENT_STOCK", code, reason)
	}
	var detail *inventoryv1.InsufficientStockDetail
	for _, d := range rest {
		if v, ok := d.(*inventoryv1.InsufficientStockDetail); ok {
			detail = v
		}
	}
	if detail == nil || len(detail.GetShortfalls()) != 2 {
		t.Fatalf("InsufficientStockDetail = %v", detail)
	}
	if sf := detail.GetShortfalls()[0]; sf.GetSku() != "KAOS-001" || sf.GetRequested() != 5 || sf.GetAvailable() != 2 {
		t.Errorf("first shortfall = %v", sf)
	}
}

func TestErrorMapping(t *testing.T) {
	tests := []struct {
		err    error
		code   codes.Code
		reason string
	}{
		{domain.ErrReservationNotFound, codes.NotFound, "RESERVATION_NOT_FOUND"},
		{domain.ErrReservationCommitted, codes.FailedPrecondition, "RESERVATION_COMMITTED"},
		{domain.ErrReservationConflict, codes.AlreadyExists, "RESERVATION_CONFLICT"},
		{domain.ErrStockBelowReserved, codes.FailedPrecondition, "STOCK_BELOW_RESERVED"},
		{domain.ErrVersionConflict, codes.Aborted, "VERSION_CONFLICT"},
		{errors.New("connection reset"), codes.Internal, ""},
		{domain.ErrInvariant, codes.Internal, ""},
	}
	for _, tt := range tests {
		t.Run(tt.err.Error(), func(t *testing.T) {
			c := client(t, &fakeStore{err: tt.err})
			_, err := c.CommitReservation(ctx(t), &inventoryv1.CommitReservationRequest{OrderId: orderID})
			code, reason, _ := details(t, err)
			if code != tt.code || reason != tt.reason {
				t.Errorf("got %v / %q, want %v / %q", code, reason, tt.code, tt.reason)
			}
		})
	}
}

func TestInternalErrorsDoNotLeakDetails(t *testing.T) {
	c := client(t, &fakeStore{err: errors.New(`ERROR: relation "stock_levels" password=hunter2`)})
	_, err := c.CommitReservation(ctx(t), &inventoryv1.CommitReservationRequest{OrderId: orderID})
	if st, _ := status.FromError(err); st.Message() != "internal error" {
		t.Errorf("internal error message = %q, want a generic message", st.Message())
	}
}

func TestCallsRespectTheCallersDeadline(t *testing.T) {
	c := client(t, &fakeStore{block: true})
	deadline, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := c.CommitReservation(deadline, &inventoryv1.CommitReservationRequest{OrderId: orderID})
	if code := status.Code(err); code != codes.DeadlineExceeded {
		t.Errorf("code = %v, want DeadlineExceeded", code)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("call took %v; the deadline was 100ms", elapsed)
	}
}

func TestCommitReservation(t *testing.T) {
	at := time.Date(2026, 10, 21, 3, 5, 0, 0, time.UTC)
	resp, err := client(t, &fakeStore{committedAt: at}).CommitReservation(ctx(t), &inventoryv1.CommitReservationRequest{OrderId: orderID})
	if err != nil || !resp.GetCommittedAt().AsTime().Equal(at) {
		t.Errorf("CommitReservation = %v, %v", resp, err)
	}

	_, err = client(t, &fakeStore{}).CommitReservation(ctx(t), &inventoryv1.CommitReservationRequest{OrderId: "nope"})
	if code, _, _ := details(t, err); code != codes.InvalidArgument {
		t.Errorf("bad order id: code = %v, want InvalidArgument", code)
	}
}

func TestReleaseReservation(t *testing.T) {
	for status, want := range map[domain.Status]inventoryv1.ReservationStatus{
		domain.StatusReleased: inventoryv1.ReservationStatus_RESERVATION_STATUS_RELEASED,
		domain.StatusExpired:  inventoryv1.ReservationStatus_RESERVATION_STATUS_EXPIRED,
	} {
		resp, err := client(t, &fakeStore{released: status}).ReleaseReservation(ctx(t), &inventoryv1.ReleaseReservationRequest{
			OrderId: orderID, Reason: inventoryv1.ReleaseReason_RELEASE_REASON_PAYMENT_FAILED,
		})
		if err != nil || resp.GetStatus() != want {
			t.Errorf("store status %s: response %v, %v; want %v", status, resp, err, want)
		}
	}
}

func TestGetStockLevels(t *testing.T) {
	store := &fakeStore{levels: []domain.StockLevel{{SKU: "KAOS-001", OnHand: 10, Reserved: 3, Version: 4}}}
	resp, err := client(t, store).GetStockLevels(ctx(t), &inventoryv1.GetStockLevelsRequest{Skus: []string{"KAOS-001", "MISSING"}})
	if err != nil {
		t.Fatalf("GetStockLevels: %v", err)
	}
	if len(resp.GetLevels()) != 1 {
		t.Fatalf("levels = %v", resp.GetLevels())
	}
	if l := resp.GetLevels()[0]; l.GetSku() != "KAOS-001" || l.GetOnHand() != 10 || l.GetReserved() != 3 || l.GetAvailable() != 7 || l.GetVersion() != 4 {
		t.Errorf("level = %v", l)
	}

	_, err = client(t, store).GetStockLevels(ctx(t), &inventoryv1.GetStockLevelsRequest{})
	if code, _, _ := details(t, err); code != codes.InvalidArgument {
		t.Errorf("empty query: code = %v, want InvalidArgument", code)
	}
}

func TestSetStockLevel(t *testing.T) {
	store := &fakeStore{level: domain.StockLevel{SKU: "KAOS-001", OnHand: 25, Reserved: 4, Version: 8}}
	resp, err := client(t, store).SetStockLevel(ctx(t), &inventoryv1.SetStockLevelRequest{Sku: "KAOS-001", OnHand: 25, ExpectedVersion: 7})
	if err != nil {
		t.Fatalf("SetStockLevel: %v", err)
	}
	if l := resp.GetLevel(); l.GetOnHand() != 25 || l.GetAvailable() != 21 || l.GetVersion() != 8 {
		t.Errorf("level = %v", l)
	}
}
