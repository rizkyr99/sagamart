# Internal identity contract (`x-sagamart-identity`) — v1.1

| | |
|---|---|
| **Status** | Accepted |
| **Defined in** | [RFC-0005 §4.2](../docs/rfc/0005-catalog-cart-gateway.md#42-api-and-contract-changes); v1.1 (service identities) in [RFC-0002 §8](../docs/rfc/0002-checkout-saga.md#8-security-and-privacy) |
| **Issuers** | The gateway (user identities); the Order service (its own service identity, v1.1) |
| **Verifiers** | Every service that receives calls from the gateway or Order: Catalog (#27), Inventory (#17), Order, Payment |

The gateway authenticates the external caller (a development JWT until Core complete, then OIDC). It then tells internal services who the caller is with a short-lived token that only the gateway can sign. Services never see or parse the external token.

**Service identities (v1.1):**

- Order calls Inventory, Payment and Catalog on its own behalf, as the checkout saga, not as a user.
- It signs its own token with its own key, `iss: "order"`.
- Each issuer has its own key set, so neither can mint the other's identities.

## Transport

| Protocol | Carried as |
|---|---|
| HTTP (Catalog) | Request header `x-sagamart-identity: <token>` |
| gRPC (Inventory, Order, Payment) | Metadata key `x-sagamart-identity` (lowercase) |

Every internal call from the gateway or Order carries one, including calls for guests and anonymous browsing. A service never accepts a request without it.

## Token

A JWS in compact serialization (RFC 7515), signed with **EdDSA / Ed25519** (RFC 8037).

Protected header:

```json
{ "alg": "EdDSA", "typ": "sagamart-identity+jwt", "kid": "gw-2026-10" }
```

Claims:

| Claim | Type | Rule |
|---|---|---|
| `iss` | string | `"gateway"` for user identities; `"order"` for the Order service's own identity (v1.1) |
| `aud` | string | The **one** service the call is for: `"catalog"`, `"inventory"`, `"order"`, `"payment"`, … |
| `sub` | string (UUID) | The authenticated user's ID. **Absent** for guests, anonymous calls and service identities. |
| `roles` | string array | Gateway: `["buyer"]`, `["admin"]`, or `[]` for guests and anonymous calls. Order: `["service:order"]`. Unknown roles are ignored. |
| `iat` | number | Issued-at, seconds since the epoch |
| `exp` | number | `iat + 60` |
| `jti` | string (UUID) | Unique per token, for log correlation; not tracked for replay |

Example claims for an admin:

```json
{
  "iss": "gateway",
  "aud": "inventory",
  "sub": "0199f2e0-0000-7000-8000-000000000001",
  "roles": ["admin"],
  "iat": 1792574400,
  "exp": 1792574460,
  "jti": "0199f2e0-55aa-7bbb-8ccc-000000000042"
}
```

## Verification (every service)

A service **must** reject the token unless all of these hold:

1. It is a well-formed compact JWS whose header `alg` is exactly `EdDSA`. Never accept `none`, and never pick the algorithm from the token itself.
2. `iss` is an issuer this service trusts (`"gateway"`, and `"order"` where the authorization table below allows it).
3. The signature verifies with a public key **from that issuer's key set**, chosen by `kid`. A key from another issuer's set never verifies a token, so the Order key can't mint gateway identities and vice versa.
4. `aud` is this service's own name.
5. `exp` is in the future and `iat` is not in the future, each allowing **5 seconds** of clock skew.
6. `sub`, when present, is a UUID; `roles` is an array of strings.

Then authorize:

| Operation | Requires | On failure |
|---|---|---|
| Any call | A valid token | HTTP `401` `UNAUTHENTICATED` / gRPC `UNAUTHENTICATED` |
| Calls a user makes through the gateway (Catalog browse, carts and admin; Inventory `GetStockLevels` and `SetStockLevel`; Order `OrderService`) | `iss: "gateway"` | as above |
| Admin operations (Catalog `/internal/v1/admin/*`, Inventory `SetStockLevel`, Order `ListOrders` and `GetSaga`) | `admin` in `roles` | HTTP `403` `FORBIDDEN` / gRPC `PERMISSION_DENIED` |
| A user's cart (`user:<id>` cart key) | `sub` equals `<id>` | HTTP `403` `FORBIDDEN` |
| A user's order (Order `GetOrder`) | `sub` is the order's buyer, or `admin` in `roles` | gRPC `NOT_FOUND` (never reveals other buyers' orders) |
| Saga commands (Inventory `ReserveStock`, `CommitReservation`, `ReleaseReservation`; every `PaymentService` RPC) | `iss: "order"` with `service:order` in `roles` | gRPC `PERMISSION_DENIED` |
| Price lookups (Catalog `skus:lookup`) | `iss: "gateway"` or `iss: "order"` | as above |

Failures are logged with the reason (never the token) and counted in `sagamart_<service>_identity_rejections_total{reason}`.

## Keys

- Keys travel as single-line environment variables: **base64 (standard alphabet) of the DER encoding**.
- Each issuer holds its own Ed25519 private key, never logged or shipped to other services:
  - the gateway: `GATEWAY_IDENTITY_KEY_ID` (the `kid`) and `GATEWAY_IDENTITY_PRIVATE_KEY` (PKCS#8 DER, base64);
  - Order: `ORDER_IDENTITY_KEY_ID` and `ORDER_IDENTITY_PRIVATE_KEY`.
- Services are configured with the public keys they trust, per issuer, each a JSON object `{ "<kid>": "<SPKI DER, base64>" }`:
  - `<SERVICE>_IDENTITY_PUBLIC_KEYS` for the gateway (unchanged from v1);
  - `<SERVICE>_ORDER_IDENTITY_PUBLIC_KEYS` for Order, set only on services Order calls (Inventory, Payment, Catalog).
- **Rotation:** add the new public key to every service, switch the gateway to the new private key and `kid`, then remove the old public key after the 60-second token lifetime has passed.
- Local development keys are generated by `make identity-keys` into the git-ignored `deploy/compose/.env`, which Compose passes to each service. Real keys never enter the repository.
  - Gateway: `IDENTITY_KEY_ID`, `IDENTITY_PRIVATE_KEY`, `IDENTITY_PUBLIC_KEYS`.
  - Order, from v1.1: `ORDER_IDENTITY_KEY_ID`, `ORDER_IDENTITY_PRIVATE_KEY`, `ORDER_IDENTITY_PUBLIC_KEYS`.

## Versioning

This is version 1.1. It adds the `"order"` issuer, which is backward compatible: a v1 verifier rejects any `iss` other than `"gateway"`, so nothing it accepts changes, and it accepts Order's identities only once it is configured with Order's key set. Adding claims is backward compatible too, and services must ignore claims they don't know. Removing or changing the meaning of a claim, or changing the algorithm, needs a new version with its own `typ` (`sagamart-identity+jwt;v=2`), accepted alongside v1 until every issuer has moved.
