// Package telemetry sets up structured logging, tracing and metrics as described in conventions §7 and §8.
package telemetry

import (
	"context"
	"io"
	"log/slog"
	"strings"

	"go.opentelemetry.io/otel/trace"
)

// timeLayout is RFC 3339 in UTC with millisecond precision (conventions §3): 2026-10-21T01:23:45.678Z.
const timeLayout = "2006-01-02T15:04:05.000Z07:00"

// NewLogger returns a JSON logger with the shared field names: ts, level, service, env, version, msg,
// and trace_id / span_id whenever the context carries a span.
func NewLogger(w io.Writer, level slog.Level, service, env, version string) *slog.Logger {
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) > 0 {
				return a
			}
			switch a.Key {
			case slog.TimeKey:
				return slog.String("ts", a.Value.Time().UTC().Format(timeLayout))
			case slog.LevelKey:
				return slog.String("level", strings.ToLower(a.Value.String()))
			}
			return a
		},
	})
	return slog.New(traceHandler{h}).With("service", service, "env", env, "version", version)
}

// traceHandler adds the active span's IDs to every record logged with a context.
type traceHandler struct{ slog.Handler }

func (h traceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

func (h traceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return traceHandler{h.Handler.WithAttrs(attrs)}
}

func (h traceHandler) WithGroup(name string) slog.Handler {
	return traceHandler{h.Handler.WithGroup(name)}
}
