package dev.sagamart.order.runner;

import com.google.protobuf.Any;
import com.google.protobuf.Message;
import com.google.protobuf.Timestamp;
import com.google.rpc.Code;
import com.google.rpc.ErrorInfo;
import dev.sagamart.contracts.inventory.v1.CommitReservationRequest;
import dev.sagamart.contracts.inventory.v1.CommitReservationResponse;
import dev.sagamart.contracts.inventory.v1.InventoryServiceGrpc;
import dev.sagamart.contracts.inventory.v1.ReleaseReservationRequest;
import dev.sagamart.contracts.inventory.v1.ReleaseReservationResponse;
import dev.sagamart.contracts.inventory.v1.ReservationStatus;
import dev.sagamart.contracts.inventory.v1.ReserveStockRequest;
import dev.sagamart.contracts.inventory.v1.ReserveStockResponse;
import dev.sagamart.contracts.payment.v1.CreatePaymentIntentRequest;
import dev.sagamart.contracts.payment.v1.CreatePaymentIntentResponse;
import dev.sagamart.contracts.payment.v1.PaymentServiceGrpc;
import dev.sagamart.contracts.payment.v1.PaymentStatus;
import dev.sagamart.contracts.payment.v1.RefundPaymentRequest;
import dev.sagamart.contracts.payment.v1.RefundPaymentResponse;
import dev.sagamart.contracts.payment.v1.VoidPaymentIntentRequest;
import dev.sagamart.contracts.payment.v1.VoidPaymentIntentResponse;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.protobuf.StatusProto;
import io.grpc.stub.StreamObserver;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Supplier;

/**
 * Inventory and Payment as their contracts describe them, in process. Each RPC answers success
 * unless a failure was scripted for it; every request is recorded.
 */
final class FakeDependencies implements AutoCloseable {

  static final Instant RESERVATION_EXPIRES = Instant.parse("2026-11-16T10:10:00Z");
  static final String PAYMENT_URL = "https://pay.example/s/1";

  /** Scripted failures per RPC, used in order; an empty script answers success. */
  private final Map<String, Deque<StatusRuntimeException>> failures = new ConcurrentHashMap<>();

  /** Failures repeated for every call of an RPC. */
  private final Map<String, StatusRuntimeException> always = new ConcurrentHashMap<>();

  final List<Message> requests = new CopyOnWriteArrayList<>();

  private final Server server;
  final ManagedChannel channel;

  FakeDependencies() {
    String name = InProcessServerBuilder.generateName();
    try {
      server =
          InProcessServerBuilder.forName(name)
              .directExecutor()
              .addService(new Inventory())
              .addService(new Payment())
              .build()
              .start();
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    channel = InProcessChannelBuilder.forName(name).directExecutor().build();
  }

  /** The next call of {@code rpc} fails with {@code error}; call again to queue more. */
  FakeDependencies failNext(String rpc, StatusRuntimeException error) {
    failures.computeIfAbsent(rpc, _ -> new ArrayDeque<>()).addLast(error);
    return this;
  }

  /** Every call of {@code rpc} fails with {@code error}, until {@link #recover}. */
  FakeDependencies failAlways(String rpc, StatusRuntimeException error) {
    always.put(rpc, error);
    return this;
  }

  void recover(String rpc) {
    always.remove(rpc);
  }

  <T extends Message> List<T> requests(Class<T> type) {
    return requests.stream().filter(type::isInstance).map(type::cast).toList();
  }

  /** A domain error as the services send it: a status with an ErrorInfo detail. */
  static StatusRuntimeException domainError(Code code, String domain, String reason) {
    return StatusProto.toStatusRuntimeException(
        com.google.rpc.Status.newBuilder()
            .setCode(code.getNumber())
            .setMessage(reason.toLowerCase().replace('_', ' '))
            .addDetails(
                Any.pack(ErrorInfo.newBuilder().setDomain(domain).setReason(reason).build()))
            .build());
  }

  static StatusRuntimeException status(io.grpc.Status status) {
    return status.withDescription("scripted").asRuntimeException();
  }

  private <T> void answer(
      String rpc, Message request, StreamObserver<T> observer, Supplier<T> reply) {
    requests.add(request);
    StatusRuntimeException failure = always.get(rpc);
    if (failure == null) {
      Deque<StatusRuntimeException> queued = failures.get(rpc);
      failure = queued == null ? null : queued.pollFirst();
    }
    if (failure != null) {
      observer.onError(failure);
      return;
    }
    observer.onNext(reply.get());
    observer.onCompleted();
  }

  private static Timestamp timestamp(Instant i) {
    return Timestamp.newBuilder().setSeconds(i.getEpochSecond()).setNanos(i.getNano()).build();
  }

  private final class Inventory extends InventoryServiceGrpc.InventoryServiceImplBase {
    @Override
    public void reserveStock(
        ReserveStockRequest request, StreamObserver<ReserveStockResponse> observer) {
      answer(
          "ReserveStock",
          request,
          observer,
          () ->
              ReserveStockResponse.newBuilder()
                  .setReservationId("res-" + request.getOrderId())
                  .setExpiresAt(timestamp(RESERVATION_EXPIRES))
                  .build());
    }

    @Override
    public void commitReservation(
        CommitReservationRequest request, StreamObserver<CommitReservationResponse> observer) {
      answer(
          "CommitReservation",
          request,
          observer,
          () ->
              CommitReservationResponse.newBuilder()
                  .setCommittedAt(timestamp(RESERVATION_EXPIRES.minusSeconds(60)))
                  .build());
    }

    @Override
    public void releaseReservation(
        ReleaseReservationRequest request, StreamObserver<ReleaseReservationResponse> observer) {
      answer(
          "ReleaseReservation",
          request,
          observer,
          () ->
              ReleaseReservationResponse.newBuilder()
                  .setStatus(ReservationStatus.RESERVATION_STATUS_RELEASED)
                  .build());
    }
  }

  private final class Payment extends PaymentServiceGrpc.PaymentServiceImplBase {
    @Override
    public void createPaymentIntent(
        CreatePaymentIntentRequest request, StreamObserver<CreatePaymentIntentResponse> observer) {
      answer(
          "CreatePaymentIntent",
          request,
          observer,
          () ->
              CreatePaymentIntentResponse.newBuilder()
                  .setPaymentIntentId("pi-" + request.getOrderId())
                  .setStatus(PaymentStatus.PAYMENT_STATUS_REQUIRES_ACTION)
                  .setRedirectUrl(PAYMENT_URL)
                  .setExpiresAt(request.getExpiresAt())
                  .build());
    }

    @Override
    public void voidPaymentIntent(
        VoidPaymentIntentRequest request, StreamObserver<VoidPaymentIntentResponse> observer) {
      answer(
          "VoidPaymentIntent",
          request,
          observer,
          () ->
              VoidPaymentIntentResponse.newBuilder()
                  .setStatus(PaymentStatus.PAYMENT_STATUS_VOIDED)
                  .build());
    }

    @Override
    public void refundPayment(
        RefundPaymentRequest request, StreamObserver<RefundPaymentResponse> observer) {
      answer(
          "RefundPayment",
          request,
          observer,
          () ->
              RefundPaymentResponse.newBuilder()
                  .setRefundId("rf-" + request.getOrderId())
                  .setStatus(PaymentStatus.PAYMENT_STATUS_REFUNDED)
                  .build());
    }
  }

  @Override
  public void close() {
    channel.shutdownNow();
    server.shutdownNow();
  }
}
