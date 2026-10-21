package telemetry_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"

	"github.com/rizkyr99/sagamart/services/inventory/internal/telemetry"
)

func decode(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("log line is not JSON: %v\n%s", err, buf)
	}
	return line
}

func TestLoggerWritesConventionFields(t *testing.T) {
	var buf bytes.Buffer
	log := telemetry.NewLogger(&buf, slog.LevelInfo, "inventory", "test", "1.2.3")

	log.Info("reservation created", "order_id", "0199f29e")

	line := decode(t, &buf)
	for key, want := range map[string]string{
		"level": "info", "service": "inventory", "env": "test", "version": "1.2.3",
		"msg": "reservation created", "order_id": "0199f29e",
	} {
		if line[key] != want {
			t.Errorf("%s = %v, want %q", key, line[key], want)
		}
	}

	ts, ok := line["ts"].(string)
	if !ok {
		t.Fatalf("ts missing: %v", line)
	}
	parsed, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		t.Fatalf("ts %q is not RFC 3339: %v", ts, err)
	}
	if _, offset := parsed.Zone(); offset != 0 || ts[len(ts)-1] != 'Z' {
		t.Errorf("ts %q is not UTC", ts)
	}
	if _, ok := line["time"]; ok {
		t.Error("slog's default time key should be renamed to ts")
	}
}

func TestLoggerAddsTraceAndSpanIDs(t *testing.T) {
	var buf bytes.Buffer
	log := telemetry.NewLogger(&buf, slog.LevelInfo, "inventory", "test", "dev").With("sku", "KAOS-001")

	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{0x4b, 0xf9, 0x2f, 0x35, 0x77, 0xb3, 0x4d, 0xa6, 0xa3, 0xce, 0x92, 0x9d, 0x0e, 0x0e, 0x47, 0x36},
		SpanID:     trace.SpanID{0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7},
		TraceFlags: trace.FlagsSampled,
	})
	ctx := trace.ContextWithSpanContext(context.Background(), sc)

	log.InfoContext(ctx, "reserved")

	line := decode(t, &buf)
	if line["trace_id"] != "4bf92f3577b34da6a3ce929d0e0e4736" || line["span_id"] != "00f067aa0ba902b7" {
		t.Errorf("trace fields wrong: trace_id=%v span_id=%v", line["trace_id"], line["span_id"])
	}
	if line["sku"] != "KAOS-001" {
		t.Errorf("attributes from With lost: %v", line)
	}
}

func TestLoggerOmitsTraceFieldsWithoutSpan(t *testing.T) {
	var buf bytes.Buffer
	telemetry.NewLogger(&buf, slog.LevelInfo, "inventory", "test", "dev").Info("started")

	line := decode(t, &buf)
	if _, ok := line["trace_id"]; ok {
		t.Errorf("trace_id present without a span: %v", line)
	}
}

func TestLoggerRespectsLevel(t *testing.T) {
	var buf bytes.Buffer
	telemetry.NewLogger(&buf, slog.LevelWarn, "inventory", "test", "dev").Info("hidden")
	if buf.Len() != 0 {
		t.Errorf("info logged at warn level: %s", buf.String())
	}
}
