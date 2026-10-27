package dev.sagamart.order.grpc;

import dev.sagamart.contracts.order.v1.OrderServiceGrpc;
import org.springframework.stereotype.Service;

/**
 * {@code sagamart.order.v1.OrderService}. Every RPC answers {@code UNIMPLEMENTED} (the generated
 * base class's default) until persistence and the runner land (RFC-0002 §10 step 4, #60).
 */
@Service
public class OrderGrpcService extends OrderServiceGrpc.OrderServiceImplBase {}
