# 7. API reference

> Part of the [Invoice Exception Assistant specification](./README.md). Applies to version **1.0.0**.

This is the exhaustive reference for the HTTP API. A shorter task-oriented summary is in
[`docs/api.md`](../docs/api.md). The routes are implemented in [`server/app.ts`](../server/app.ts); request
shapes are the Zod schemas in [`src/domain/validation.ts`](../src/domain/validation.ts); response shapes are in
[`src/domain/types.ts`](../src/domain/types.ts) and [`src/domain/api.ts`](../src/domain/api.ts).

> **Audience and stability.** The API exists to serve the bundled web UI. It is **unversioned** and may change
> in any release. If external systems must integrate, add a versioned, documented surface first
> ([roadmap](./13-limitations-and-roadmap.md#133-roadmap-suggestions)).

## 7.1 Conventions

| Topic | Rule |
| --- | --- |
| Base path | `/api`, same origin as the web app. No CORS headers are sent — browsers on other origins cannot read responses. |
| Format | JSON in and out (`Content-Type: application/json`), except `POST /invoices` which may be `multipart/form-data`, and the two download endpoints. |
| Authentication | Session cookie (`__Host-invoice_session` in production, `invoice_session` in development/test). No bearer tokens, API keys or basic auth. |
| Safe methods | `GET`, `HEAD`, `OPTIONS` — no Origin/CSRF requirement. |
| Unsafe methods | Everything else requires **`Origin` exactly equal to `APP_ORIGIN`** *and*, once signed in, **`X-CSRF-Token`** equal to the session's token. |
| Caching | Every API response carries `Cache-Control: no-store`. |
| Request tracing | Every response carries `X-Request-Id`; error bodies repeat it as `requestId`. |
| Identifiers | Path/body references must match `^[a-zA-Z0-9-]{1,80}$`, else `400 VALIDATION_ERROR`. |
| Unknown properties | Rejected (`400`) wherever a schema applies: every request body, and every query string an endpoint accepts, is parsed with a strict schema. Endpoints that take no query parameters (for example `/dashboard`) ignore any that are supplied. |
| Timestamps | UTC ISO-8601 with milliseconds. Business dates are `YYYY-MM-DD`. |
| Money | JSON numbers in USD with at most two decimals. |

### Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Check the submitted fields.",
    "details": [ { "path": "invoice.tax", "message": "Use at most two decimal places." } ]
  },
  "requestId": "e2ac5bba-f43c-4bde-a823-df63a03ef640"
}
```

`details` is optional. For validation errors it is an array of `{ path, message }`; for
`UNRESOLVED_EXCEPTIONS` on approval it is `{ "exceptions": [ExceptionEvidence…] }`. Program logic should use
`error.code`, never `message`. Responses never contain stack traces, SQL, or password material.

### Pagination envelope

```json
{ "items": [ … ], "total": 57, "page": 2, "limit": 25 }
```

`page` ≥ 1 (≤ 100,000), `limit` 1–100 (default 25). A page past the end returns an empty `items` array with
the true `total`. Ordering is stable (ties broken by ID).

All paginated endpoints share one base query schema, which also accepts `search` (≤ 100 characters). It is
*used* only by the invoice and reference-data lists; the history, export, user and audit endpoints accept it
and **ignore** it. Any other query parameter on those endpoints is rejected with `400`.

## 7.2 Calling the API from a script

Browsers add `Origin` and cookies automatically; scripts must do it themselves. The password is placed in a
file so it does not appear in the process list.

```bash
BASE=https://invoices.example.com          # exactly APP_ORIGIN
printf '{"email":"admin@example.com","password":"%s"}' "$ADMIN_PASSWORD" > /tmp/login.json

# 1. Sign in. Keep the cookie jar and read the CSRF token.
curl -s -c jar.txt -H "Origin: $BASE" -H "Content-Type: application/json" \
     -d @/tmp/login.json "$BASE/api/auth/login" > session.json
CSRF=$(jq -r .csrfToken session.json)

# 2. A read needs only the cookie.
curl -s -b jar.txt "$BASE/api/dashboard"

# 3. A write needs the cookie, the Origin header, and the CSRF header.
curl -s -b jar.txt -H "Origin: $BASE" -H "X-CSRF-Token: $CSRF" \
     -H "Content-Type: application/json" -X POST \
     -d '{"version":1,"action":"approved","note":""}' "$BASE/api/invoices/<id>/review"
```

If the temporary-password flag is set the session works only for `/auth/*` until the password is changed.

## 7.3 Limits

### Rate limits

Counters live in PostgreSQL and are shared by all API instances. The request that **exceeds** the limit gets
`429 RATE_LIMITED` with a `Retry-After` header (seconds).

| Limiter | Counted per | Limit | Window | Applies to |
| --- | --- | ---: | --- | --- |
| Login by address | client IP | 30 | 15 min | `POST /auth/login` |
| Login by account | submitted e-mail | 10 | 15 min | `POST /auth/login`; **reset on a successful login** |
| Password change | user | 10 | 15 min | `POST /auth/change-password` |
| Mutations | user | 120 | 1 min | Every unsafe request to business routes (after the password gate) |
| Document intake | user | 60 | 1 hour | `POST /invoices` (in addition to the mutation limit) |

### Size and shape limits

| Limit | Value |
| --- | --- |
| JSON body | 128 KiB (`413 PAYLOAD_TOO_LARGE`) |
| Multipart | exactly one `document` file ≤ 10 MiB and one `data` field ≤ 128 KiB; at most 2 parts |
| Reverse proxy (supplied Caddyfile) | request body ≤ 11 MB |
| Line items | ≤ 100 per invoice/PO/receipt |
| Export batch | 1–500 invoices |
| Notes | ≤ 1,000 characters |
| Search text | ≤ 100 characters |
| Server timeouts | request 30 s, headers 15 s |

## 7.4 Data shapes

Abbreviated; the complete definitions are in the source files named above.

```ts
type Role = "admin" | "reviewer";
interface User { id: string; email: string; name: string; role: Role; active: boolean; mustChangePassword: boolean }
interface Session { user: User; csrfToken: string }

type InvoiceStatus = "needs_review" | "possible_duplicate" | "matched" | "ready_to_export"
                   | "correction_requested" | "escalated" | "exported" | "voided";

interface LineItem { id: string; sku: string; description: string; quantity: number; unitPrice: number }

interface Invoice {
  id: string; version: number; invoiceNumber: string;
  supplierId: string; date: string; dueDate: string;            // "" when unset
  purchaseOrderId: string; deliveryRecordId?: string; currency: "USD";
  lineItems: LineItem[]; tax: number; status: InvoiceStatus;
  extractedFields: { label: string; value: string; confidence?: number; source: "manual" | "demo_extraction" }[];
  sourceFile?: { name: string; type: string; size?: number };    // bytes are never included
  exportBatchId?: string;
}

interface InvoiceSummary {                                       // rows in lists
  id: string; invoiceNumber: string; date: string; dueDate: string; status: InvoiceStatus; version: number;
  supplierName: string;            // "Not assigned" if none
  supplierCode: string;
  purchaseOrderNumber: string;     // "Not linked" if none
  total: number; exceptionCount: number; exceptionReason: string;  // first exception's title, or ""
}

interface InvoiceDetail {
  invoice: Invoice; supplier?: Supplier; purchaseOrder?: PurchaseOrder; delivery?: DeliveryRecord;
  exceptions: ExceptionEvidence[];                               // LIVE, see §4
  history: PageResult<ReviewHistory>;                            // first page, newest first, with snapshots
}

interface ReviewHistory {
  id: string; invoiceId: string; invoiceNumber?: string; version?: number;
  action: "created" | "updated" | "approved" | "correction_requested" | "escalated" | "reopened" | "exported" | "voided";
  user: string; timestamp: string; detail: string; snapshot?: Invoice;   // snapshot only on per-invoice endpoints
}

interface Supplier { id: string; name: string; code: string; location: string }
interface PurchaseOrder { id: string; poNumber: string; supplierId: string; orderedDate: string; lineItems: LineItem[] }
interface DeliveryRecord { id: string; deliveryNumber: string; purchaseOrderId: string; receivedDate: string;
                           lineItems: { id: string; sku: string; description: string; quantity: number }[] }
interface ExportBatch { id: string; createdAt: string; createdBy: string; invoiceCount: number }
interface AuditEvent { id: string; action: string; entityId: string; user: string; detail: string; timestamp: string }
interface DashboardData { counts: Record<InvoiceStatus, number>; priority: InvoiceSummary[]; history: ReviewHistory[] }
```

### Request bodies

```jsonc
// InvoiceInput — every key is required; use "" / [] / 0 for "not yet known"
{
  "invoiceNumber": "NFM-24081",
  "supplierId": "",              // "" or an existing supplier ID
  "date": "2026-09-18",          // "" or a valid ISO date
  "dueDate": "2026-10-18",       // "" or a valid ISO date, not before "date"
  "purchaseOrderId": "",         // "" or a PO belonging to the supplier
  "deliveryRecordId": "",        // "" or a receipt belonging to the PO
  "lineItems": [ { "sku": "BRG-6204", "description": "Sealed ball bearing", "quantity": 24, "unitPrice": 18.5 } ],
  "tax": 38.88
}
```

## 7.5 Authentication and session

### `POST /auth/login`
Public (but `Origin` is enforced). Body `{ "email", "password" }` (strict; password 1–128 chars; e-mail is
trimmed and lower-cased). Applies the two login rate limits first.

- **200** `{ user, csrfToken }` and `Set-Cookie` (`HttpOnly; SameSite=Strict; Path=/; Max-Age=<SESSION_HOURS×3600>`,
  plus `Secure` in production). A new server-generated session is created; earlier sessions of the same user
  stay valid until they expire or are revoked.
- **401 `INVALID_CREDENTIALS`** — unknown e-mail, wrong password, or disabled account; the response is
  identical in all three cases and a password check is always performed.
- **400, 403 `ORIGIN_REJECTED`, 429.**

### `GET /auth/me`
**200** `{ user, csrfToken }` for the current session. **401** `UNAUTHENTICATED` (no/malformed cookie) or
`SESSION_EXPIRED` (cookie without a live session or user disabled; the cookie is cleared).

### `POST /auth/logout`
Requires CSRF. Deletes this session, clears the cookie. **200** `{ "ok": true }`.

### `POST /auth/change-password`
Requires CSRF. Body `{ "currentPassword", "newPassword" }` (new: 12–128 chars, not whitespace-only). Usable
while a temporary password is in force. Rate-limited (10 / 15 min / user).

- **200** `{ user, csrfToken }` — **all** of the user's sessions are deleted and a fresh one is issued (new
  cookie). Writes a `password_changed` audit event.
- **400 `INCORRECT_PASSWORD`**, **400 `PASSWORD_REUSE`**, **400 `VALIDATION_ERROR`**, **401**, **429**.

## 7.6 Dashboard

### `GET /dashboard`
**200** `DashboardData`:

- `counts` — every status with its stored-label count (zero-filled).
- `priority` — up to 4 invoices in `needs_review`, `possible_duplicate`, `escalated` or `correction_requested`,
  **oldest invoice date first**.
- `history` — the 5 most recent history events across all invoices (no snapshots).

## 7.7 Invoices

### `GET /invoices`
Query (strict): `page`, `limit`, `search` (matches invoice number, supplier name or PO number; literal,
case-insensitive), `status` (`all` or any status, default `all`), `sort` (`date_desc` default, `date_asc`,
`amount_desc`, `supplier`). **200** `PageResult<InvoiceSummary>`. Exception fields are evaluated live per row.

### `POST /invoices`
Creates a draft. Rate limits: document intake and mutation. Two encodings:

**JSON** — `{ "requestId": "<uuid>", "invoice": InvoiceInput }`.
**Multipart** — field `data` = that same JSON as a string; file field `document` (optional PDF/PNG/JPEG).
The multipart boundary must be set by the HTTP client.

- **201** `{ "id": "<invoice id>" }` (equal to `requestId`). **Replaying** the same request (same user, same
  content, same file) returns **201** with the same ID and creates nothing.
- **400** `VALIDATION_ERROR` · `INVALID_JSON` (bad/missing `data`) · `INVALID_UPLOAD` (extra or oversized
  parts/fields) ·
  `INVALID_DOCUMENT` (size < 12 B, real type not PDF/PNG/JPEG, MIME ≠ detected type, or extension mismatch) ·
  **413** (document > 10 MiB or JSON > 128 KiB) · **409 `IDEMPOTENCY_CONFLICT`** · **422 `INVALID_REFERENCE`**
  (unknown supplier/PO/receipt) · **422 `REFERENCE_MISMATCH`** (PO not the supplier's; receipt not the PO's).
- Initial status is derived by the rules ([§4.6](./04-matching-and-exceptions.md#46-status-derivation)). A
  history row `created` (version 1) is written. Filename is sanitized (basename, NFKC, control characters
  removed, ≤ 200 chars).

### `GET /invoices/:id`
**200** `InvoiceDetail` (live `exceptions`; history first page with snapshots). **404 `NOT_FOUND`**.

### `GET /invoices/:id/history`
Query: `page`, `limit`. **200** `PageResult<ReviewHistory>` with `snapshot` on every item. **404** if the
invoice does not exist.

### `PUT /invoices/:id`
Body `{ "version": <int>, "invoice": InvoiceInput, "note": "<1–1000 chars>" }`. Only for **editable** statuses.
Re-validates references, regenerates line IDs and provenance fields, re-derives the status, increments the
version and writes an `updated` history row.

- **200** the updated `Invoice`.
- **409 `VERSION_CONFLICT`** · **409 `INVALID_TRANSITION`** (invoice is `ready_to_export`, `exported` or
  `voided`) · **404** · **422** (references) · **400**.

### `POST /invoices/:id/review`
Body `{ "version": <int>, "action": "approved" | "correction_requested" | "escalated" | "reopened" | "voided",
"note": "<string>" }`. `note` must be present; it must be **non-empty for every action except `approved`**.
`reopened` requires the **administrator** role.

- **200** the updated `Invoice`.
- **409 `VERSION_CONFLICT`** · **409 `INVALID_TRANSITION`** (action not allowed in the current state; reopen of
  anything but `ready_to_export`) · **422 `UNRESOLVED_EXCEPTIONS`** (approval only; `details.exceptions` lists
  the live evidence) · **403 `FORBIDDEN`** (reopen by a reviewer) · **404** · **400**.

### `GET /invoices/:id/document`
Streams the stored file. **200** with `Content-Type` = the detected type, `Content-Disposition: attachment;
filename="<sanitized name>"`, `Content-Security-Policy: sandbox; default-src 'none'`, `X-Content-Type-Options:
nosniff`, `Cache-Control: no-store`. **404** if there is no document (or no such invoice).

## 7.8 Exports

### `GET /exports`
Query: `page`, `limit`. **200** `PageResult<ExportBatch>`, newest first.

### `POST /exports`
Body `{ "requestId": "<uuid>", "invoices": [ { "id", "version" }, … ] }` — 1–500 entries, no repeated IDs.

- **201** `{ "id": "<batch id>" }` (equal to `requestId`); replays with the same user and selection return the
  same 201.
- **409 `VERSION_CONFLICT`** · **409 `NOT_EXPORTABLE`** (not `ready_to_export`, including already exported) ·
  **422 `UNRESOLVED_EXCEPTIONS`** (re-check failed; the message names the invoice number) ·
  **409 `IDEMPOTENCY_CONFLICT`** · **404** (an invoice does not exist) · **400** (empty, > 500, or repeated IDs).
- All-or-nothing. See [§5.6](./05-invoice-lifecycle.md#56-export-batches).

### `GET /exports/:id/download`
**200** `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="invoices-<id>.csv"`, the same
sandbox CSP header, and a leading UTF-8 byte-order mark. **404** if unknown.

## 7.9 Reference data

Available to every signed-in user for reading; administrators create.

| Route | Purpose | Notes |
| --- | --- | --- |
| `GET /suppliers` | List | Query `page`, `limit`, `search` (name or code); sorted by name |
| `GET /purchase-orders` | List | Adds `supplierId` filter; sorted by order date, newest first |
| `GET /deliveries` | List | Adds `purchaseOrderId` filter; sorted by received date, newest first |
| `GET /suppliers/:id`, `/purchase-orders/:id`, `/deliveries/:id` | One record | An unknown ID returns **422 `INVALID_REFERENCE`** (not 404) |
| `POST /suppliers` | Create (admin) | Body `{ name, code, location }` → **201** `Supplier`; duplicate code → 409 `ALREADY_EXISTS` |
| `POST /purchase-orders` | Create (admin) | Body `{ poNumber, supplierId, orderedDate, lineItems:[{sku,description,quantity,unitPrice}] }` → **201** `PurchaseOrder` (with generated line IDs) |
| `POST /deliveries` | Create (admin) | Body `{ deliveryNumber, purchaseOrderId, receivedDate, lineItems:[{sku,description,quantity}] }` → **201** `DeliveryRecord` |

Filters used on the wrong list (`supplierId` on anything but purchase orders, `purchaseOrderId` on anything but
deliveries) return **400 `INVALID_FILTER`**. Receipt creation returns **422 `INVALID_RECEIPT`** if the date
precedes the PO, a SKU is not on the PO, or cumulative received quantity would exceed the ordered quantity.
Records cannot be edited or deleted.

## 7.10 Administration

All require the **administrator** role (`403 FORBIDDEN` otherwise).

| Route | Body / query | Result |
| --- | --- | --- |
| `GET /admin/users` | `page`, `limit` | **200** `PageResult<User>`, oldest account first |
| `POST /admin/users` | `{ email, name, role, password }` | **201** `User` with `mustChangePassword: true`; **409** duplicate e-mail |
| `PATCH /admin/users/:id` | `{ active, role }` — **both required** | **200** `User`; target's sessions deleted; **409 `SELF_MANAGEMENT_BLOCKED`** for your own ID; **404** |
| `POST /admin/users/:id/reset-password` | `{ password }` | **200** `{ "ok": true }`; sets `mustChangePassword`, deletes target's sessions; **409** for your own ID; **404** |
| `GET /admin/audit` | `page`, `limit` | **200** `PageResult<AuditEvent>`, newest first |

## 7.11 Health

| Route | Auth | Result |
| --- | --- | --- |
| `GET /health/live` | none | **200** `{ "status": "ok" }` — the process is up |
| `GET /health/ready` | none | **200** `{ "status": "ok" }` if `SELECT 1` succeeds; otherwise **503 `NOT_READY`** (no diagnostic detail is exposed) |

## 7.12 Error code catalog

| Code | HTTP | Raised when |
| --- | :---: | --- |
| `UNAUTHENTICATED` | 401 | No cookie or malformed token |
| `SESSION_EXPIRED` | 401 | No live session for the token, or the account is no longer active |
| `INVALID_CREDENTIALS` | 401 | Login failed (unknown, wrong password, or disabled) |
| `ORIGIN_REJECTED` | 403 | Unsafe request whose `Origin` is missing or not exactly `APP_ORIGIN` |
| `CSRF_REJECTED` | 403 | Missing or wrong `X-CSRF-Token` |
| `FORBIDDEN` | 403 | Administrator role required |
| `PASSWORD_CHANGE_REQUIRED` | 403 | Temporary password still in force |
| `RATE_LIMITED` | 429 | A rate limit was exceeded (see `Retry-After`) |
| `VALIDATION_ERROR` | 400 | A body/query/path failed schema validation (`details` lists fields) |
| `INVALID_JSON` | 400 | Malformed JSON, or multipart without a valid `data` field |
| `INVALID_UPLOAD` | 400 / 413 | Multipart limits: extra parts, extra fields or an oversized `data` field (400); file over 10 MiB (413) |
| `INVALID_DOCUMENT` | 400 | Document too small, wrong real type, MIME/extension mismatch, no filename |
| `INVALID_FILTER` | 400 | Filter not supported by this list |
| `INCORRECT_PASSWORD` | 400 | Wrong current password |
| `PASSWORD_REUSE` | 400 | New password equals the current one |
| `PAYLOAD_TOO_LARGE` | 413 | JSON body over 128 KiB |
| `NOT_FOUND` | 404 | Invoice, document, export batch, user, API endpoint or static file not found |
| `ALREADY_EXISTS` | 409 | Unique constraint (e-mail, supplier code, PO or receipt number) |
| `VERSION_CONFLICT` | 409 | The supplied version is not the current version |
| `INVALID_TRANSITION` | 409 | The action is not allowed in the invoice's current status |
| `NOT_EXPORTABLE` | 409 | Invoice is not `ready_to_export` |
| `IDEMPOTENCY_CONFLICT` | 409 | `requestId` already used for different content or by another user |
| `SELF_MANAGEMENT_BLOCKED` | 409 | An administrator targeted their own account |
| `LAST_ADMIN` | 409 | Defensive guard: the change would leave no active administrator |
| `NOT_EMPTY` | 409 | Seeding refused (**CLI only**, never returned over HTTP) |
| `UNRESOLVED_EXCEPTIONS` | 422 | Approval or export blocked by current exceptions |
| `INVALID_REFERENCE` | 422 | A referenced supplier/PO/receipt does not exist (also unknown ID on `GET /<reference>/:id`) |
| `REFERENCE_MISMATCH` | 422 | PO not the supplier's, or receipt not the PO's |
| `INVALID_RECEIPT` | 422 | Receipt date, SKU, or quantity rule violated |
| `INTERNAL_ERROR` | 500 | Unexpected failure, including lock/statement timeouts and pool exhaustion; quote the `requestId` |
| `NOT_READY` | 503 | Readiness check could not reach the database |

The web client also synthesizes `NETWORK_ERROR` (status 0), `INVALID_RESPONSE` (200 but not JSON — typically a
proxy misconfiguration) and `HTTP_ERROR` (non-JSON error body). These never come from the server.
