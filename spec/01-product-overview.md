# 1. Product overview

> Part of the [Invoice Exception Assistant specification](./README.md). Applies to version **1.0.0**.

## 1.1 What the application is

Invoice Exception Assistant is a **self-hosted accounts-payable (AP) workspace for one finance team**.
Staff record supplier invoices, optionally attach the scanned document, and compare each invoice with
two other records:

- the **purchase order (PO)** it should be billed against, and
- the **goods receipt** (called a *delivery record* in the code) that proves the goods arrived.

Comparing those three documents is a **three-way match**. Anything that does not line up becomes an
**exception**: a rule-generated finding that carries the exact numbers that explain it. An invoice can
only be **approved** when it has *no* exceptions. Approved invoices are then released in controlled
**CSV export batches** for hand-off to whichever finance system the organization uses.

Everything that matters is decided and recorded on the **server** and stored in **PostgreSQL**:
the matching rules, the approval decision, who made it, what the invoice looked like at that moment,
and the exact CSV that was released.

## 1.2 Problems it addresses

| Risk in manual invoice processing | How the application responds |
| --- | --- |
| **Duplicate payment** – the same invoice is entered twice, or arrives twice | Same supplier + same (normalized) invoice number is flagged on *both* records and blocks approval. The wrong record is **voided** with a reason, not deleted. See [matching rules](./04-matching-and-exceptions.md#43-rule-catalog). |
| **Overbilling on price** | Unit price above the PO price by more than **5 %** is an exception, evaluated in exact cents. |
| **Overbilling on quantity** | Invoiced quantity above what was *received* or *ordered* is an exception. Quantities already committed by other approved/exported invoices on the same PO or receipt are subtracted, so several smaller invoices cannot add up to more than was delivered. |
| **Incomplete or unverified data** | Required fields, valid dates, a PO and a receipt are all mandatory before approval. Manual edits require an audit reason. |
| **No accountability** | Every change is an immutable, versioned history entry with the acting user, a timestamp, a plain-language detail, and a full snapshot of the invoice at that version. |
| **Unsafe hand-off** | Exports are idempotent, re-validated at export time, permanently retained, re-downloadable, and lock the invoices they contain. |
| **Lost work / concurrent edits** | Optimistic version checks reject stale changes instead of silently overwriting a colleague's work. |

## 1.3 Design principles

These principles explain *why* the system behaves as it does. Each is enforced in code, not just intended.

1. **The server decides.** The browser is never trusted. The same rule engine
   ([`src/services/invoiceChecks.ts`](../src/services/invoiceChecks.ts)) is used by the API for every
   decision; the UI only displays its output.
2. **No override.** An exception blocks approval for *everyone*, administrators included. The only ways
   forward are to correct the data, request a correction, escalate, or void the invoice.
3. **Evidence is immutable.** Review history, administrative audit events, export batches, suppliers,
   purchase orders and goods receipts cannot be updated or deleted — enforced by database triggers *and*
   by withholding those privileges from the runtime database role.
4. **Failures are explicit.** The UI never shows success before the server confirms it, and it never
   pretends an external system was contacted. Missing capabilities (OCR, e-mail, ERP) are stated plainly.
5. **Mutations are safe to retry.** Creating an invoice or an export uses a client-generated request ID;
   edits and decisions carry the version they were based on.
6. **Least privilege, simple operations.** Two database roles, a non-root read-only application
   container, one production Compose file (plus a development database file), no message queue, no cache, no
   external services.
7. **A small, trusted team.** One deployment = one finance team. Every active user can see every
   invoice; there is no per-record access control. See [limitations](./13-limitations-and-roadmap.md).

## 1.4 Users and roles

There are exactly two roles. Accounts are created by an administrator (or by the operator's CLI for the
very first administrator) — **there is no public registration**.

| Capability | Reviewer | Administrator |
| --- | :---: | :---: |
| Sign in; view dashboard, invoice queue, invoice details, review history | ✔ | ✔ |
| Download source documents and export CSVs | ✔ | ✔ |
| Create invoice drafts (with an optional PDF/PNG/JPEG) | ✔ | ✔ |
| Edit invoice fields while the invoice is in an editable state | ✔ | ✔ |
| Approve · request correction · escalate · void | ✔ | ✔ |
| Create export batches | ✔ | ✔ |
| Look up suppliers, purchase orders and goods receipts | ✔ | ✔ |
| Change their own password | ✔ | ✔ |
| **Reopen** an approved, not-yet-exported invoice | — | ✔ |
| Create suppliers, purchase orders, goods receipts | — | ✔ |
| Create accounts; change role or enabled state; set temporary passwords | — | ✔ (never for themselves) |
| Read the administrative audit log | — | ✔ |

Notes:

- A reviewer **can approve an invoice they created**. There is no two-person rule; add one if your
  controls require it ([roadmap](./13-limitations-and-roadmap.md#133-roadmap-suggestions)).
- Roles are re-read from the database inside each write transaction, so a demoted or disabled user loses
  access immediately, not at the end of their session. See [security](./08-security.md#85-authorization).

## 1.5 Feature inventory

**Access and accounts**
- Administrator-created reviewer/administrator accounts; first-use password change is forced for
  accounts created in the UI; password reset, enable/disable, role change; sessions revoked on every
  such change. → [Security](./08-security.md), [Lifecycle §5.7](./05-invoice-lifecycle.md#57-account-lifecycle)

**Invoice intake**
- Manual draft entry with incomplete data allowed; optional document (PDF, PNG, JPEG ≤ 10 MiB) stored
  in the database; supplier → PO → receipt cascading pickers; "use PO line items" shortcut; unsaved-change
  protection. → [Frontend](./09-frontend.md)

**Verification (three-way match)**
- Deterministic rules: required fields, duplicates, price tolerance, SKU-not-on-PO, ordered-quantity and
  received-quantity availability with cross-invoice reservation, blank/low-confidence fields. Evidence is
  shown with the source values and the calculation. → [Matching rules](./04-matching-and-exceptions.md)

**Review decisions**
- Approve (only when clean) · request correction · escalate · void · admin-only reopen. Reasons are
  mandatory for everything except approval. Version-checked, history-recorded.
  → [Lifecycle](./05-invoice-lifecycle.md)

**Exports**
- Select up to 500 approved invoices; one retained, immutable CSV batch per request; automatic
  re-validation at export time; invoices become `exported` and locked; batches can be re-downloaded.
  → [Lifecycle §5.6](./05-invoice-lifecycle.md#56-export-batches)

**Reference data**
- Administrators create suppliers, purchase orders and goods receipts (immutable once saved). Receipts
  are validated against the PO's remaining quantity. → [Domain model](./03-domain-model.md)

**Audit and traceability**
- Per-invoice versioned history with full snapshots; administrator audit log for account, reference-data
  and export events; request IDs in every error response and in every per-request server log line.

**Operations**
- Docker Compose deployment with automatic HTTPS, health endpoints, structured logs, graceful shutdown,
  explicit migrations, least-privilege database role, CI pipeline. → [Deployment](./10-configuration-and-deployment.md),
  [Operations](./12-operations.md)

## 1.6 Typical journeys

### Day-zero setup
1. The operator deploys the stack ([deployment](./10-configuration-and-deployment.md)) and runs the
   `create-admin` CLI command. No default credentials exist.
2. The administrator signs in and creates **suppliers**, **purchase orders** and **goods receipts**.
3. The administrator creates reviewer accounts with **temporary passwords** and shares them securely
   (the application sends no e-mail).
4. Each reviewer signs in, is forced to choose a private password, and lands on the dashboard.

### Enter and verify an invoice
1. **New invoice** → optionally attach the scan → pick the supplier → the PO list narrows to that
   supplier → the receipt list narrows to that PO → optionally *Use PO line items*.
2. Enter dates, quantities, unit prices and tax → **Save draft**. Incomplete drafts are allowed.
3. The review page lists any **exceptions** with their evidence. Use **Edit invoice** to correct data,
   giving a reason; the invoice is re-evaluated and a new version is recorded.
4. When no exceptions remain, **Approve for export** becomes available.

### Resolve a duplicate
Both records show *Possible duplicate*. Compare them, **void** the incorrect one with a reason (it stays
in the history and no longer blocks anything), then approve the other.

### Deal with a bad price or quantity
Either the data entry was wrong (edit and re-verify), or the supplier is wrong. Use **Request
correction** (an internal status plus note — nothing is sent) or **Escalate**, and record the reason.

### Export
On **Exports**, tick the approved invoices and **Create CSV export**. The CSV downloads immediately,
the invoices become **Exported** and read-only, and the batch stays in **Export history** so a failed
download can be repeated without exporting anything twice.

### Manage access
An administrator creates, disables, re-enables, re-roles accounts or sets a temporary password; every
such action revokes that user's sessions and appears in the administrative audit log.

## 1.7 What the application deliberately does not do

| Not provided | Detail |
| --- | --- |
| OCR / document understanding | Uploaded documents are stored as received; all fields are typed by a person (`source: "manual"`). No document is sent anywhere. |
| AI / ML | All decisions come from deterministic rules. |
| E-mail or notifications | *Request correction* and *Escalate* are recorded statuses, not messages. |
| ERP, bank or payment integration | Only a CSV file is produced. "Exported" means a batch was created, **not** that another system imported it. |
| Multi-currency | USD only (enforced by a database `CHECK`). |
| Multi-tenant isolation | One team per deployment. |
| SSO / MFA | Local accounts with salted-scrypt passwords. |
| Tax calculation | Tax is a typed amount. |
| Credit notes / negative amounts | All amounts are ≥ 0. |
| Payments, remittance, payment status | Out of scope. |
| Editing or deleting reference data | Suppliers, POs and receipts are immutable evidence; corrections are made by creating a replacement and relinking draft invoices. |
| Public API or webhooks | The API exists to serve the bundled UI and is unversioned. |

## 1.8 Product history

**0.1.0 – local demo.** A React + Vite single-page app holding seven synthetic invoices **in browser
memory** (lost on reload), a hard-coded reviewer persona, review actions that only changed local state, an
upload that created a local draft without keeping the file, a browser-generated CSV, and placeholder
`ExtractionService` / `ErpService` interfaces.

**1.0.0 – production service.** The demo was converted into a multi-user service: Express API, PostgreSQL
persistence, accounts and sessions, server-side rules and workflows, immutable audit, retained exports,
reference-data administration, hardened deployment, and an automated test suite. The empty-by-default
workspace replaced the sample data. The unused placeholder interfaces were removed; reintroduce an
extraction or ERP boundary when a real provider is integrated.

Leftovers from the demo era that are **not** part of the running application:

| Path | What it is |
| --- | --- |
| [`images/`](../images) | Screenshots of the **0.1.0 demo** UI ("DEMO MODE", "Maya Chen"). They no longer match the product and are kept only for history. |
| [`pgm.py`](../pgm.py) | A one-line `print("Hello world")` stub unrelated to the application. Excluded from the container image. |
| [`src/data/demoData.ts`](../src/data/demoData.ts) | The original synthetic dataset, **repurposed** as development seed data and test fixtures (see [§3.12](./03-domain-model.md#312-sample-dataset)). |

## 1.9 Where to go next

- How it is built → [Architecture](./02-architecture.md)
- What the data looks like → [Domain model](./03-domain-model.md)
- How matching works → [Matching and exceptions](./04-matching-and-exceptions.md)
- How invoices move → [Invoice lifecycle](./05-invoice-lifecycle.md)
