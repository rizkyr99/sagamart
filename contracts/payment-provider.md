# Payment provider contract — v1

| | |
|---|---|
| **Status** | Accepted |
| **Defined in** | [RFC-0002 §4.2, §4.5, §8](../docs/rfc/0002-checkout-saga.md) |
| **Provider** | The mock payment provider (`services/mock-payment-provider`), dev and test only |
| **Client** | Payment's provider adapter: the anti-corruption layer (context map). Provider statuses map to Sagamart's `PaymentStatus` there and nowhere else. |

Sagamart never sees card data: the buyer pays on the provider's own page, as with a real gateway. The provider tells Payment the outcome through signed webhooks. Payment can also ask the provider directly, before a void and when reconciling.

## Provider API (Payment → provider)

JSON over HTTP, base URL `PAYMENT_PROVIDER_URL`. Every request carries `Authorization: Bearer <PAYMENT_PROVIDER_API_KEY>`. Every call is idempotent on its `Idempotency-Key` header, and a repeat returns the original response.

| Method and path | Purpose | Answer |
|---|---|---|
| `POST /v1/sessions` | Start a payment: `{ "reference": "<payment intent id>", "amount": 158000, "currency": "IDR", "expiresAt": "<RFC 3339>" }` | `201 { id, status, payUrl, expiresAt }` |
| `GET /v1/sessions/{id}` | The session's current status: the truth Payment uses before a void and when reconciling | `200 { id, status, capturedAt?, failure? }` |
| `POST /v1/sessions/{id}/void` | Cancel an unpaid session | `200 { id, status: "VOIDED" }`, or `409 { code: "ALREADY_CAPTURED" }` if it was paid |
| `POST /v1/sessions/{id}/refunds` | Refund a captured session in full | `201 { refundId, status: "SUCCEEDED" }`, or `409 { code: "NOT_CAPTURED" }` |

**Session statuses:**

| Status | Meaning | Becomes |
|---|---|---|
| `OPEN` | Waiting for the buyer | `CAPTURED` or `DECLINED` when the buyer pays; `VOIDED` on a void; `EXPIRED` after `expiresAt` |
| `CAPTURED` | Money taken | `REFUNDED` |
| `DECLINED` | The buyer's payment was declined | — |
| `VOIDED` | Cancelled before payment | — |
| `EXPIRED` | Not paid in time | — |
| `REFUNDED` | Captured, then refunded in full | — |

A session that is `CAPTURED` can never become `VOIDED`, and a `VOIDED` or `EXPIRED` session can never be captured. That rule is what lets Payment's void settle the race with a late payment.

## Webhooks (provider → Payment)

`POST <PAYMENT_WEBHOOK_URL>` (Payment's `/webhooks/provider`), sent on every status change:

```json
{
  "eventId": "evt_0199f2b1c4d5",
  "type": "session.captured",
  "sessionId": "ses_0199f2b1a2b3",
  "reference": "0199f2b1-7b22-7c31-a4d5-6e7f8091a2b4",
  "status": "CAPTURED",
  "amount": 158000,
  "currency": "IDR",
  "occurredAt": "2026-10-26T03:12:40.104Z"
}
```

- **Types:** `session.captured`, `session.declined`, `session.voided`, `session.expired`, `session.refunded`, one per status change, with the same payload. `session.voided` follows a successful void; Payment already knows from the void's own answer, so it treats the webhook as a confirmation.
- **Delivery is at least once,** with retries on any non-`2xx` answer: 1 s, 5 s, 30 s, 2 min, 10 min. The same `eventId` may arrive several times, and Payment applies each `eventId` once.
- **Payment answers `200` to a duplicate.** A `4xx` or `5xx` makes the provider retry, so Payment only refuses webhooks it can't trust or can't store.

**Signature.** Each delivery has a header:

```http
Provider-Signature: t=1792980760,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

- `v1` is `HMAC-SHA256(PAYMENT_PROVIDER_WEBHOOK_SECRET, "<t>.<raw body>")`, in hex.
- Payment rejects a delivery (`401`) unless the signature matches, compared in constant time, and `t` is within **5 minutes** of its own clock.
- The timestamp is inside the signed text, so an old delivery can't be replayed with a fresh `t`.

## Test control (mock provider only)

`POST /control/...` exists only with `MOCK_PROVIDER_CONTROL=true`, and the mock provider refuses to start with it in `prod`. It lets tests and chaos experiments script the provider:

| Control | Effect |
|---|---|
| `outcome` | The next payments are `CAPTURED` or `DECLINED` without a buyer |
| `webhookDelayMs` | Delay webhooks |
| `webhookDrop` | Drop the next N webhooks, so reconciliation has to find the outcome |
| `webhookDuplicates` | Deliver each webhook N times, for chaos C2 |

The exact control endpoints are documented in the mock provider's README; they aren't part of what a real provider would offer.

## Versioning

This is version 1. A real provider adapter would map its own API onto these concepts inside Payment. The contract describes the concepts Payment depends on, so a provider change stays inside the adapter.
