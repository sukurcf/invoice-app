# Glossary

> Part of the [Invoice Exception Assistant specification](./README.md).

Terms are listed alphabetically. Section links point to the document that defines the concept in detail.

| Term | Meaning |
| --- | --- |
| **Accounts payable (AP)** | The finance function that verifies and pays supplier invoices. |
| **Administrator** | A user with the `admin` role: can also reopen approved invoices, create reference data, manage accounts, and read the administrative audit. See [§1.4](./01-product-overview.md#14-users-and-roles). |
| **Advisory lock (global workflow lock)** | The PostgreSQL transaction-scoped lock `(20261002, 1)` taken by every business write so cross-record rules are race-free. See [§5.5](./05-invoice-lifecycle.md#55-concurrency-control). |
| **Approve / approval** | The decision that moves an editable invoice to `ready_to_export`. Allowed only when the invoice has **zero current exceptions**. |
| **Audit event** | An insert-only workspace-level record of administrative activity (accounts, reference data, exports). Different from an invoice's *history*. See [§5.8](./05-invoice-lifecycle.md#58-history-and-audit-trail). |
| **Available quantity** | The quantity still usable on a PO or receipt after subtracting units committed to other approved/exported invoices. See [§4.4](./04-matching-and-exceptions.md#44-precise-definitions). |
| **Bootstrap superuser / owner role** | The database role (`invoice_owner`) created by the Postgres image; used only for migrations, backups and administration — never by the running API. See [§6.8](./06-data-and-persistence.md#68-database-roles-and-privileges). |
| **Committed (reserved) quantity** | Units of a SKU already consumed on the same PO or receipt by other invoices in `ready_to_export` or `exported`. |
| **Confidence** | A 0–1 score attached to an extracted field in the sample data; below 0.80 raises an exception. Manual entry has none. |
| **CSRF token** | A random per-session value the browser sends in `X-CSRF-Token` on unsafe requests. See [§8.4](./08-security.md#84-sessions-cookies-and-csrf). |
| **Delivery record** | The code's name for a **goods receipt**. |
| **Draft** | An invoice that has been saved but not approved; may be incomplete. Not a separate status — drafts are invoices in an editable status. |
| **Editable status** | One of `needs_review`, `possible_duplicate`, `matched`, `correction_requested`, `escalated`. See [§3.2](./03-domain-model.md#32-enumerations). |
| **Evidence** | The structured explanation attached to an exception: title, explanation, source values, calculation. See [§4.7](./04-matching-and-exceptions.md#47-evidence-structure). |
| **Exception** | A finding produced by the rule engine. Derived on demand, never stored, and always blocking. |
| **Export batch** | An immutable, retained set of approved invoices released together as one CSV. See [§5.6](./05-invoice-lifecycle.md#56-export-batches). |
| **Exported** | The final status of an invoice included in an export batch. Does **not** mean another system imported it. |
| **Fingerprint** | SHA-256 over an invoice's parsed content and document, used to detect a conflicting reuse of a request ID. |
| **Goods receipt (GRN)** | A record that goods arrived: receipt number, PO, date and received quantities per SKU. |
| **History (invoice history)** | The insert-only, per-invoice list of versions with actor, detail and full snapshot. |
| **Idempotency / request ID** | A client-generated UUID that makes creating an invoice or export safe to retry; it becomes the new record's ID. See [§5.4](./05-invoice-lifecycle.md#54-idempotency). |
| **Invoice key** | The normalized invoice number (NFKC, trimmed, whitespace-collapsed, lower-cased) used for duplicate detection. |
| **Migration ledger** | The `schema_migrations` table recording applied migration files and their checksums. See [§6.7](./06-data-and-persistence.md#67-migrations). |
| **Normalization (NFKC)** | Unicode compatibility normalization applied to text input so visually identical text compares equal. |
| **Optimistic concurrency / version** | The integer on each invoice that must match on every write; a mismatch is `409 VERSION_CONFLICT`. See [§5.3](./05-invoice-lifecycle.md#53-versioning-and-optimistic-concurrency). |
| **Origin check** | The rule that every unsafe request's `Origin` header must equal `APP_ORIGIN`. |
| **Provenance** | Where a field value came from: `manual` (typed by a person) or `demo_extraction` (sample data only). |
| **Purchase order (PO)** | The agreement with a supplier: PO number, supplier, date, and ordered quantity and price per SKU. |
| **Reference data** | Suppliers, purchase orders and goods receipts — immutable once created. |
| **Reopen** | Administrator-only action that returns an approved, un-exported invoice to `needs_review`. |
| **Reviewer** | A user with the `reviewer` role: the day-to-day AP user. |
| **Runtime role** | The limited database role (`invoice_app`) the API connects as. |
| **Session** | A server-side record keyed by the hash of an opaque cookie token; absolute lifetime `SESSION_HOURS`. |
| **SKU** | Stock-keeping unit; the key used to match invoice lines to PO and receipt lines. Upper-cased on input. |
| **Snapshot** | The complete invoice as it was at a given version, stored with its history entry. |
| **Temporary password** | A password set by an administrator (or the CLI) that must be replaced at the next sign-in. |
| **Three-way match** | Comparing an invoice with its PO and its goods receipt. |
| **Tolerance** | The permitted price difference: invoice unit price may exceed the PO price by up to **5 %**. |
| **Void** | Canceling an invoice with a reason. Permanent; it stays in history but stops affecting duplicate and quantity checks. |
| **Workflow** | In code, the `workflow()` function that wraps every business write in a transaction with the global lock and an actor re-check. |
