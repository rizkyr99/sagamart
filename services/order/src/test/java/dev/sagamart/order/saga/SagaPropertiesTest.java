package dev.sagamart.order.saga;

import static org.assertj.core.api.Assertions.assertThat;

import dev.sagamart.order.saga.OrderEvent.OrderCancelled;
import dev.sagamart.order.saga.OrderEvent.OrderConfirmed;
import dev.sagamart.order.saga.SagaCommand.CommitReservation;
import dev.sagamart.order.saga.SagaCommand.CreatePaymentIntent;
import dev.sagamart.order.saga.SagaCommand.RefundPayment;
import dev.sagamart.order.saga.SagaCommand.ReleaseReservation;
import dev.sagamart.order.saga.SagaCommand.ReserveStock;
import dev.sagamart.order.saga.SagaCommand.VoidPaymentIntent;
import dev.sagamart.order.saga.SagaEvent.AlreadyCaptured;
import dev.sagamart.order.saga.SagaEvent.InsufficientStock;
import dev.sagamart.order.saga.SagaEvent.IntentCreated;
import dev.sagamart.order.saga.SagaEvent.IntentVoided;
import dev.sagamart.order.saga.SagaEvent.PaymentDeadlinePassed;
import dev.sagamart.order.saga.SagaEvent.PaymentFailed;
import dev.sagamart.order.saga.SagaEvent.PaymentSucceeded;
import dev.sagamart.order.saga.SagaEvent.Refunded;
import dev.sagamart.order.saga.SagaEvent.ReservationExpired;
import dev.sagamart.order.saga.SagaEvent.ReservationNotFound;
import dev.sagamart.order.saga.SagaEvent.ReservationReleased;
import dev.sagamart.order.saga.SagaEvent.RetriesExhausted;
import dev.sagamart.order.saga.SagaEvent.StockCommitted;
import dev.sagamart.order.saga.SagaEvent.StockReserved;
import dev.sagamart.order.saga.SagaState.AwaitingPayment;
import dev.sagamart.order.saga.SagaState.Cancelled;
import dev.sagamart.order.saga.SagaState.Completed;
import dev.sagamart.order.saga.SagaState.CreatingPayment;
import dev.sagamart.order.saga.SagaState.NeedsAttention;
import dev.sagamart.order.saga.SagaState.ReservingStock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import net.jqwik.api.ForAll;
import net.jqwik.api.Property;
import net.jqwik.api.constraints.IntRange;
import net.jqwik.api.constraints.Size;

/**
 * RFC-0002 §9: whatever happens, the saga ends terminal or NEEDS_ATTENTION, never confirms without
 * a commit, and never ends CANCELLED holding money or stock.
 *
 * <p>Random moves drive a small model of the world (Inventory's reservation, Payment's intent, the
 * buyer, an event bus that redelivers and reorders) and the saga together. Calls may fail, give up,
 * or take effect with their reply lost. Then the dependencies recover and the saga is run until it
 * stops; the invariants are checked on the world, not on what the saga believes.
 */
class SagaPropertiesTest {

  enum Move {
    RUN_COMMAND,
    RUN_COMMAND_REFUSED,
    RUN_COMMAND_GIVES_UP,
    RUN_COMMAND_GIVES_UP_AFTER_EFFECT,
    BUYER_PAYS,
    BUYER_PAYMENT_FAILS,
    RESERVATION_EXPIRES,
    DEADLINE_PASSES,
    DELIVER_OLDEST,
    DELIVER_NEWEST,
    REDELIVER_OLDEST
  }

  enum Intent {
    NONE,
    OPEN,
    CAPTURED,
    FAILED,
    VOIDED
  }

  static final Instant RESERVATION_EXPIRES = Instant.parse("2026-10-29T10:10:00Z");

  /** Inventory, Payment and the event bus, as they really are. */
  static final class World {
    boolean stockHeld;
    boolean stockCommitted;
    Intent intent = Intent.NONE;
    boolean refunded;
    final Deque<SagaEvent> bus = new ArrayDeque<>();

    boolean holdsMoney() {
      return intent == Intent.CAPTURED && !refunded;
    }
  }

  /** The saga, and everything it has published. */
  static final class Run {
    final World world = new World();
    SagaState state = new ReservingStock();
    final List<OrderEvent> published = new ArrayList<>();

    void apply(SagaEvent event) {
      Transition t = Saga.apply(state, event);
      state = t.to();
      published.addAll(t.publish());
    }

    void move(Move move) {
      switch (move) {
        case RUN_COMMAND -> run(Outcome.OK);
        case RUN_COMMAND_REFUSED -> run(Outcome.REFUSED);
        case RUN_COMMAND_GIVES_UP -> run(Outcome.GIVE_UP);
        case RUN_COMMAND_GIVES_UP_AFTER_EFFECT -> run(Outcome.GIVE_UP_AFTER_EFFECT);
        case BUYER_PAYS -> {
          if (world.intent == Intent.OPEN) {
            world.intent = Intent.CAPTURED;
            world.bus.addLast(new PaymentSucceeded());
          }
        }
        case BUYER_PAYMENT_FAILS -> {
          if (world.intent == Intent.OPEN) {
            world.intent = Intent.FAILED;
            world.bus.addLast(new PaymentFailed());
          }
        }
        case RESERVATION_EXPIRES -> {
          if (world.stockHeld) {
            world.stockHeld = false;
            world.bus.addLast(new ReservationExpired());
          }
        }
        // The deadline scan only selects sagas awaiting payment.
        case DEADLINE_PASSES -> {
          if (state instanceof AwaitingPayment) {
            apply(new PaymentDeadlinePassed());
          }
        }
        case DELIVER_OLDEST -> {
          if (!world.bus.isEmpty()) {
            apply(world.bus.removeFirst());
          }
        }
        case DELIVER_NEWEST -> {
          if (!world.bus.isEmpty()) {
            apply(world.bus.removeLast());
          }
        }
        case REDELIVER_OLDEST -> {
          if (!world.bus.isEmpty()) {
            apply(world.bus.peekFirst());
          }
        }
        default -> throw new IllegalStateException(move.name());
      }
    }

    enum Outcome {
      OK,
      /** A business refusal where the call has one: Inventory out of stock. */
      REFUSED,
      GIVE_UP,
      GIVE_UP_AFTER_EFFECT
    }

    /** The runner executes the pending command against the world and applies its result. */
    void run(Outcome outcome) {
      SagaCommand command = state.pendingCommand().orElse(null);
      if (command == null) {
        return;
      }
      boolean effect = outcome != Outcome.GIVE_UP;
      SagaEvent result =
          switch (command) {
            case ReserveStock _ -> {
              if (outcome == Outcome.REFUSED) {
                yield new InsufficientStock();
              }
              world.stockHeld |= effect;
              yield new StockReserved(RESERVATION_EXPIRES);
            }
            case CreatePaymentIntent c -> {
              if (effect && world.intent == Intent.NONE) {
                world.intent = Intent.OPEN;
              }
              yield new IntentCreated("https://pay.example/s/1", c.expiresAt());
            }
            case CommitReservation _ -> {
              if (!world.stockHeld) {
                yield new ReservationNotFound();
              }
              if (effect) {
                world.stockHeld = false;
                world.stockCommitted = true;
              }
              yield new StockCommitted();
            }
            case VoidPaymentIntent _ -> {
              // Payment asks the provider first: a captured payment is never voided.
              if (world.intent == Intent.CAPTURED) {
                yield new AlreadyCaptured();
              }
              if (effect && world.intent != Intent.NONE) {
                world.intent = Intent.VOIDED;
              }
              yield new IntentVoided();
            }
            case ReleaseReservation _ -> {
              world.stockHeld &= !effect;
              yield new ReservationReleased();
            }
            case RefundPayment _ -> {
              world.refunded |= effect && world.intent == Intent.CAPTURED;
              yield new Refunded();
            }
          };
      // A call that gave up reports that instead of its result, whether or not it took effect.
      boolean gaveUp = outcome == Outcome.GIVE_UP || outcome == Outcome.GIVE_UP_AFTER_EFFECT;
      apply(gaveUp ? new RetriesExhausted() : result);
    }

    /** The dependencies recover: run commands, deliver what is queued, let the deadline pass. */
    void drain() {
      for (int step = 0; step < 100 && !stopped(); step++) {
        if (state.pendingCommand().isPresent()) {
          run(Outcome.OK);
        } else if (!world.bus.isEmpty()) {
          apply(world.bus.removeFirst());
        } else if (state instanceof AwaitingPayment) {
          apply(new PaymentDeadlinePassed());
        }
      }
    }

    boolean stopped() {
      return state.isTerminal() || state instanceof NeedsAttention;
    }
  }

  @Property(tries = 3000)
  void anyHistoryEndsSafely(@ForAll @Size(max = 60) List<Move> moves) {
    Run run = new Run();
    moves.forEach(run::move);
    run.drain();

    assertThat(run.stopped()).as("stops at a terminal state or NEEDS_ATTENTION").isTrue();
    if (run.state instanceof Completed) {
      assertThat(run.world.stockCommitted).as("confirmed only with stock committed").isTrue();
      assertThat(run.world.holdsMoney()).as("confirmed only when paid").isTrue();
    }
    if (run.state instanceof Cancelled) {
      assertThat(run.world.holdsMoney()).as("cancelled never keeps the money").isFalse();
      assertThat(run.world.stockHeld).as("cancelled never keeps stock reserved").isFalse();
    }
  }

  @Property(tries = 3000)
  void announcesEachOutcomeOnceAndNeverBoth(@ForAll @Size(max = 60) List<Move> moves) {
    Run run = new Run();
    moves.forEach(run::move);
    run.drain();

    long confirmed = run.published.stream().filter(OrderConfirmed.class::isInstance).count();
    long cancelled = run.published.stream().filter(OrderCancelled.class::isInstance).count();
    assertThat(confirmed).isLessThanOrEqualTo(1);
    assertThat(cancelled).isLessThanOrEqualTo(1);
    assertThat(confirmed + cancelled).as("never both confirmed and cancelled").isLessThan(2);
    if (confirmed == 1) {
      assertThat(run.world.stockCommitted).as("never confirms without a commit").isTrue();
    }
  }

  @Property
  void paymentDeadlineNeverOutlivesTheReservation(
      @ForAll @IntRange(min = -30, max = 30) int intentOffsetMinutes) {
    Instant intentExpires = RESERVATION_EXPIRES.plus(Duration.ofMinutes(intentOffsetMinutes));
    Transition t =
        Saga.apply(
            new CreatingPayment(RESERVATION_EXPIRES),
            new IntentCreated("https://pay.example/s/1", intentExpires));

    Instant marginBeforeReservation = RESERVATION_EXPIRES.minus(Duration.ofMinutes(2));
    assertThat(((AwaitingPayment) t.to()).paymentDeadline())
        .isEqualTo(
            intentExpires.isBefore(marginBeforeReservation)
                ? intentExpires
                : marginBeforeReservation);
  }
}
