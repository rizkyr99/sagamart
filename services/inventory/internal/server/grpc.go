package server

import (
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
)

// NewGRPCServer returns a gRPC server with tracing and RED metrics on every call, and the standard health service.
// Reflection is enabled outside prod so grpcurl works locally. Callers register InventoryService on the server.
func NewGRPCServer(env string) (*grpc.Server, *health.Server) {
	srv := grpc.NewServer(grpc.StatsHandler(otelgrpc.NewServerHandler()))
	hs := health.NewServer()
	healthpb.RegisterHealthServer(srv, hs)
	if env != "prod" {
		reflection.Register(srv)
	}
	return srv, hs
}
