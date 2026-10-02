# API and workflow contract

All endpoints are same-origin under `/api`. Responses are JSON except document
and CSV downloads. Protected responses use `Cache-Control: no-store`.

This is the concise contract. The exhaustive reference (every endpoint, limit,
shape and error code) is [the API reference](../spec/07-api-reference.md) in the
specification.

## Authentication

| Method/path | Purpose |
| --- | --- |
| `GET /health/live` | Public process liveness. |
| `GET /health/ready` | Public database readiness; no credentials or diagnostics. |
| `POST /auth/login` | `{email,password}` -> `{user,csrfToken}` and an HttpOnly session cookie. |
| `GET /auth/me` | Current public user and session CSRF token. |
| `POST /auth/logout` | Revoke this session and clear its cookie. |
| `POST /auth/change-password` | `{currentPassword,newPassword}`; revoke old sessions, issue a new one. |

Every mutation, including login, requires an `Origin` exactly equal to the
configured `APP_ORIGIN`. Authenticated mutations also require `X-CSRF-Token`
from the session response. Requests use the session cookie; there is no bearer
token or public registration API. Do not store the token/password in localStorage.

An active account with `mustChangePassword=true` can use only the session,
logout, and password-change endpoints. All finance/admin endpoints require the
temporary password to have been replaced.

## Invoices

| Method/path | Purpose |
| --- | --- |
| `GET /dashboard` | Counts, oldest priority invoices, recent review events. |
| `GET /invoices` | Paginated invoice summaries with current server matching evidence. |
| `POST /invoices` | Create an incomplete or complete draft; idempotent by `requestId`. |
| `GET /invoices/:id` | Invoice, references, current exceptions, first history page. |
| `PUT /invoices/:id` | `{version,invoice,note}` to edit an eligible invoice. |
| `POST /invoices/:id/review` | `{version,action,note}`; validated transition. |
| `GET /invoices/:id/history` | Paginated history with immutable version snapshots. |
| `GET /invoices/:id/document` | Authenticated source-document attachment, if present. |

List parameters:

- `page`: 1-based; default 1.
- `limit`: 1-100; default 25.
- `search`: up to 100 characters; literal matching against number/supplier/PO.
- `status`: `all` or an invoice status.
- `sort`: `date_desc`, `date_asc`, `amount_desc`, or `supplier`.

Every page is `{items,total,page,limit}` with a stable ID tie-breaker. Dashboard
counts describe workflow status. An invoice may acquire a new exception after
it was matched or approved; current exception results, not the stored status
label, determine whether approval/export is permitted.

Example creation body:

```json
{
  "requestId": "363d607c-1e3e-4e85-b425-5c34c56a4388",
  "invoice": {
    "invoiceNumber": "INV-100",
    "supplierId": "",
    "date": "2026-10-02",
    "dueDate": "2026-11-02",
    "purchaseOrderId": "",
    "deliveryRecordId": "",
    "lineItems": [],
    "tax": 0
  }
}
```

To attach a document, submit `multipart/form-data` with exactly one `data` field
containing that JSON and one `document` file. The browser must supply the
multipart boundary. File limit: 10 MiB. Supported MIME types are PDF, PNG and
JPEG, with matching file signatures, declared MIME types, and filename extensions. Documents are not embedded as active
content and are not sent to an external extraction provider.

Line items are `{sku,description,quantity,unitPrice}`. Server-generated IDs,
currency (`USD`), status, version, actor, provenance, and timestamps cannot be
set by clients. Updating fields records them as manually verified; the user
must supply an audit reason.

Creation stores a fingerprint of metadata and document content. Reusing a
request ID with the same actor/content returns the existing invoice; different
content or actor produces HTTP 409. Retain the original ID when retrying an
ambiguous network failure.

## Status transitions

Editable states: `needs_review`, `possible_duplicate`, `matched`,
`correction_requested`, `escalated`.

| Action | Allowed from | Result |
| --- | --- | --- |
| Save fields | Any editable state | Re-evaluate as `matched`, `possible_duplicate`, or `needs_review`; increment version. |
| `approved` | Any editable state, only with zero current exceptions | `ready_to_export`. |
| `correction_requested` | Any editable state; reason required | Internal request, no email; `correction_requested`. |
| `escalated` | Any editable state; reason required | Internal escalation; `escalated`. |
| `voided` | Any editable state; reason required | `voided`, permanently locked and excluded from duplicate checks. |
| `reopened` | `ready_to_export`; administrator only; reason required | `needs_review`; approval revoked. |
| Export | `ready_to_export`; checks and versions still valid | `exported`, permanently locked. |

No exception override exists. Invalid transitions and stale versions return
409; unresolved exceptions return 422. Every successful change produces one
new version and one history snapshot in the same transaction.

Approval and export use a transaction-wide database lock shared across API
instances. Approved/exported quantities reserve units on both the PO and the
receipt, preventing multiple distinct invoice numbers from overbilling the
same source quantities.

## Export batches

| Method/path | Purpose |
| --- | --- |
| `GET /exports` | Paginated immutable batch history. |
| `POST /exports` | `{requestId,invoices:[{id,version},...]}`; 1-500 unique approved invoices. |
| `GET /exports/:id/download` | Download the exact persisted CSV. |

Export requests are idempotent for the same actor and selection/versions,
independent of selection order. The batch, CSV, statuses, and history events
commit together. A failed validation leaves no partial batch.

The downloaded CSV is UTF-8 with a byte-order mark and CRLF-separated rows (the
stored text has neither a BOM nor a trailing newline). Columns are:

```text
Invoice number,Supplier,Invoice date,Currency,Total,Purchase order,Status
```

The persisted CSV's status column is `Ready to export`: it describes the
approved state at handoff. The app's invoice becomes `exported` when the batch
commits. Text beginning with spreadsheet formula/control prefixes is prefixed
with an apostrophe; downstream importers should treat these columns as text.
Quoted fields escape commas, quotes and line breaks.

## Reference data and administration

| Method/path | Access / purpose |
| --- | --- |
| `GET /suppliers`, `GET /suppliers/:id` | Any active, password-verified user. |
| `GET /purchase-orders`, `GET /purchase-orders/:id` | Optional `supplierId` list filter. |
| `GET /deliveries`, `GET /deliveries/:id` | Optional `purchaseOrderId` list filter. |
| `POST /suppliers` | Admin; `{name,code,location}`. |
| `POST /purchase-orders` | Admin; `{poNumber,supplierId,orderedDate,lineItems}`. |
| `POST /deliveries` | Admin; `{deliveryNumber,purchaseOrderId,receivedDate,lineItems}`; receipt lines omit `unitPrice`. |
| `GET /admin/users` | Admin; paginated public account records, never password hashes. |
| `POST /admin/users` | Admin; `{email,name,role,password}`; first-login rotation required. |
| `PATCH /admin/users/:id` | Admin; `{active,role}`; revokes target sessions. |
| `POST /admin/users/:id/reset-password` | Admin; `{password}`; revokes target sessions and requires rotation. |
| `GET /admin/audit` | Admin; paginated append-only administrative events. |

Reference lists use `page`, `limit`, and `search`. Reference codes/numbers are
case-insensitively unique. PO lines use the invoice line schema; receipts cannot
exceed their PO's remaining unreceived quantities or precede its order date.
Reference records cannot be edited/deleted because they are approval evidence.

## Errors and limits

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Another user changed this invoice. Reload it before continuing."
  },
  "requestId": "e2ac5bba-f43c-4bde-a823-df63a03ef640"
}
```

Validation errors may add `{path,message}` entries in `error.details`; rejected
approvals may add current exception evidence. Do not rely on human messages for
program logic. No stack trace, password, or SQL statement is returned.

- 400: invalid input, malformed JSON, invalid upload.
- 401: missing/expired session or invalid login.
- 403: wrong origin/CSRF, insufficient role, password change required.
- 404: record, document, batch, or endpoint not found.
- 409: stale version, duplicate reference/account, invalid transition,
  conflicting idempotency key, or already-exported invoice.
- 413: request or upload exceeds its limit.
- 422: reference mismatch, unresolved exception, invalid receipt.
- 429: rate limit, with `Retry-After`.
- 500/503: internal failure/database readiness failure; use the request ID.

Limits: JSON/metadata 128 KiB; one document; 10 MiB document; 100 invoice lines;
100 records/page; 500 invoices/export; 100-character search; 1,000-character
review note; 12-128 character passwords.

Login is limited to 30 attempts/IP and 10 attempts/account per 15 minutes.
Password changes are limited to 10/user per 15 minutes. Authenticated mutations
are limited to 120/user/minute, with intake additionally limited to 60/user/hour.
These database-backed counters work across API instances. Session expiry is
absolute, not extended by page activity.
