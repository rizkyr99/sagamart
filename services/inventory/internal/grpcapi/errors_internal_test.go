package grpcapi

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestToStatusClassifiesOnlyTheReturnedError(t *testing.T) {
	tests := []struct {
		name         string
		err          error
		wantCode     codes.Code
		wantExpected bool
	}{
		// A database failure is internal (and logged) even if it arrives after the deadline passed.
		{"database error", errors.New("connection reset by peer"), codes.Internal, false},
		{"wrapped deadline", fmt.Errorf("timeout: %w", context.DeadlineExceeded), codes.DeadlineExceeded, true},
		{"wrapped cancel", fmt.Errorf("query: %w", context.Canceled), codes.Canceled, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st, expected := toStatus(tt.err)
			if code := status.Code(st); code != tt.wantCode || expected != tt.wantExpected {
				t.Errorf("toStatus = %v, expected=%v; want %v, expected=%v", code, expected, tt.wantCode, tt.wantExpected)
			}
		})
	}
}
