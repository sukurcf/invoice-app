# 6. Data and persistence

> Part of the [Invoice Exception Assistant specification](./README.md). Applies to version **1.0.0**.

All state lives in a single PostgreSQL 18 database in the `public` schema (named `invoices` in the supplied
Compose files and examples; the application accepts any database name in `DATABASE_URL`). The schema is
defined by versioned SQL in [`server/migrations/`](../server/migrations/) and applied by the migration runner in
[`server/database.ts`](../server/database.ts). Entity semantics are in [§3](./03-domain-model.md); this document
covers *storage*.

## 6.1 Overview

| Group | Tables |
| --- | --- |
| Identity and security | `users`, `sessions`, `rate_limits` |
| Reference data (insert-only) | `suppliers`, `purchase_orders`, `delivery_records` |
| Workflow | `invoices` (mutable through versioned workflows) |
| Evidence (insert-only) | `invoice_history`, `audit_events`, `export_batches` |
| Housekeeping | `schema_migrations` (the migration ledger) |

There are **no sequences, views, stored procedures (apart from one trigger function) or extensions** in use.
Identifiers are application-generated `text` UUIDs, so the database has no auto-increment keys.

## 6.2 Table reference

### `users`

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text | **PK** |
| `email` | text | NOT NULL, **UNIQUE**, `CHECK (email = lower(email))` |
| `name` | text | NOT NULL |
| `password_hash` | text | NOT NULL; format `scrypt-32768-8-3$<salt-hex>$<hash-hex>` |
| `role` | text | NOT NULL, `CHECK IN ('admin','reviewer')` |
| `active` | boolean | NOT NULL, default `true` |
| `must_change_password` | boolean | NOT NULL, default `true` |
| `created_at` | timestamptz | NOT NULL, default `now()` |

### `sessions`

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `token_hash` | text | **PK**; SHA-256 (hex) of the random cookie token — the token itself is never stored |
| `user_id` | text | NOT NULL, FK → `users` |
| `csrf_token` | text | NOT NULL; 64 hex characters, returned to the browser in JSON |
| `expires_at` | timestamptz | NOT NULL; absolute expiry, never extended |
| `created_at` | timestamptz | NOT NULL, default `now()` |

Indexes: `sessions_user_idx (user_id)`, `sessions_expiry_idx (expires_at)`.

### `rate_limits`

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `key` | text | **PK**; SHA-256 (hex) of a limiter key (never a raw IP or e-mail) |
| `attempts` | integer | NOT NULL, `CHECK (attempts > 0)` |
| `reset_at` | timestamptz | NOT NULL |

Index: `rate_limits_expiry_idx (reset_at)`.

### `suppliers`

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text | **PK** |
| `name` | text | NOT NULL |
| `code` | text | NOT NULL; **unique on `lower(code)`** (`suppliers_code_idx`) |
| `location` | text | NOT NULL, default `''` |

### `purchase_orders`

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text | **PK** |
| `po_number` | text | NOT NULL; **unique on `lower(po_number)`** |
| `supplier_id` | text | NOT NULL, FK → `suppliers`; indexed |
| `ordered_date` | date | NOT NULL |
| `line_items` | jsonb | NOT NULL; must be an **array of 1–100** elements |

### `delivery_records` (goods receipts)

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text | **PK** |
| `delivery_number` | text | NOT NULL; **unique on `lower(delivery_number)`** |
| `purchase_order_id` | text | NOT NULL, FK → `purchase_orders`; indexed |
| `received_date` | date | NOT NULL |
| `line_items` | jsonb | NOT NULL; array of 1–100 elements |

### `export_batches`

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text | **PK** — the client's export `requestId` |
| `created_by` | text | NOT NULL, FK → `users` |
| `created_at` | timestamptz | NOT NULL, default `now()` |
| `request` | jsonb | NOT NULL; the selection `[{id, version}]`, **sorted by id** (idempotency comparison) |
| `invoice_ids` | jsonb | NOT NULL; ordered array of invoice IDs included |
| `csv` | text | NOT NULL; the exact CSV text (no BOM) |

### `invoices`

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text | **PK** (client `requestId` for API-created invoices) |
| `invoice_number` | text | NOT NULL, default `''` |
| `invoice_key` | text | NOT NULL; normalized duplicate key (see [§3.10](./03-domain-model.md#310-dates-time-and-text-normalization)) |
| `supplier_id` | text | NULL allowed; FK → `suppliers` |
| `issue_date`, `due_date` | date | NULL allowed; `CHECK (due_date IS NULL OR issue_date IS NULL OR due_date >= issue_date)` |
| `purchase_order_id` | text | NULL allowed; FK → `purchase_orders`; indexed |
| `delivery_record_id` | text | NULL allowed; FK → `delivery_records`; indexed |
| `currency` | text | NOT NULL, default `'USD'`, `CHECK (currency = 'USD')` |
| `line_items` | jsonb | NOT NULL; **array of 0–100** elements |
| `tax_cents` | bigint | NOT NULL, `CHECK BETWEEN 0 AND 1000000000` |
| `total_cents` | bigint | NOT NULL, `CHECK BETWEEN 0 AND 10000000000` |
| `status` | text | NOT NULL, `CHECK` in the eight statuses |
| `version` | integer | NOT NULL, default 1, `CHECK (version > 0)` |
| `extracted_fields` | jsonb | NOT NULL, default `'[]'` |
| `source_name`, `source_type`, `document` | text, text, bytea | All-or-nothing `CHECK`; `source_type IN (pdf, png, jpeg)`; `octet_length(document)` between 1 and 10,485,760 |
| `export_batch_id` | text | NULL until exported; FK → `export_batches` |
| `created_by` | text | NOT NULL, FK → `users` |
| `request_fingerprint` | text | NOT NULL; SHA-256 used for idempotency (seeded rows use a synthetic value) |
| `created_at`, `updated_at` | timestamptz | NOT NULL, default `now()` |

### `invoice_history`

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text | **PK** |
| `invoice_id` | text | NOT NULL, FK → `invoices` |
| `version` | integer | NOT NULL; **`UNIQUE (invoice_id, version)`** |
| `action` | text | NOT NULL, `CHECK` in the eight actions |
| `actor_id` | text | FK → `users` (nullable) |
| `actor_name` | text | NOT NULL — the name *at the time* |
| `detail` | text | NOT NULL |
| `snapshot` | jsonb | NOT NULL — the full invoice at this version |
| `timestamp` | timestamptz | NOT NULL, default `now()` |

### `audit_events`

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text | **PK** |
| `action` | text | NOT NULL (free vocabulary; see [§3.6](./03-domain-model.md#36-history-audit-and-export-records)) |
| `entity_id` | text | NOT NULL |
| `actor_id` | text | FK → `users`; **NULL for operator-CLI actions** |
| `actor_name` | text | NOT NULL (`Operator CLI` for the CLI) |
| `detail` | text | NOT NULL |
| `timestamp` | timestamptz | NOT NULL, default `now()` |

### `schema_migrations`

`name` (PK), `checksum` (SHA-256 of the file text), `applied_at`. Created by the runner itself.

## 6.3 JSONB document shapes

The database checks only that `line_items` is a JSON **array** of the right length. Element shapes are
validated by the application ([`validation.ts`](../src/domain/validation.ts)) before they are written.

```jsonc
// purchase_orders.line_items and invoices.line_items
[ { "id": "uuid", "sku": "BRG-6204", "description": "Sealed ball bearing", "quantity": 24, "unitPrice": 18.5 } ]

// delivery_records.line_items (no price)
[ { "id": "uuid", "sku": "BRG-6204", "description": "Sealed ball bearing", "quantity": 24 } ]

// invoices.extracted_fields   (manual entry has no "confidence")
[ { "label": "Invoice number", "value": "NFM-24081", "source": "manual" } ]

// export_batches.request
[ { "id": "invoice-uuid", "version": 3 } ]

// invoice_history.snapshot — the complete Invoice object (id, version, status, lineItems, tax,
// extractedFields, sourceFile, exportBatchId …), without document bytes
```

JSON numbers are exact decimals in `jsonb`; the application converts to cents with `Math.round(x * 100)`
before any arithmetic ([§3.9](./03-domain-model.md#39-money)).

## 6.4 Indexes

| Index | On | Purpose |
| --- | --- | --- |
| `invoices_queue_idx` | `(status, issue_date DESC, id)` | Status filter + newest-first queue |
| `invoices_duplicate_idx` | `(supplier_id, invoice_key) WHERE status <> 'voided'` | Duplicate lookup (partial index) |
| `invoices_order_idx` | `(purchase_order_id)` | Reservation lookups by PO |
| `invoices_delivery_idx` | `(delivery_record_id)` | Reservation lookups by receipt |
| `invoice_history_recent_idx` | `(timestamp DESC, id)` | Dashboard "recent activity" |
| `audit_events_recent_idx` | `(timestamp DESC, id)` | Audit listing |
| `suppliers_code_idx`, `purchase_orders_number_idx`, `delivery_records_number_idx` | `lower(...)` unique | Case-insensitive uniqueness |
| `purchase_orders_supplier_idx`, `delivery_records_order_idx` | FK columns | Cascading pickers |
| `sessions_user_idx`, `sessions_expiry_idx`, `rate_limits_expiry_idx` | | Revocation and cleanup |

Free-text search (`ILIKE '%term%'`) cannot use these indexes and scans; that is fine for the intended
volume but is the first thing to revisit at scale ([§12.5](./12-operations.md#125-capacity-and-scaling)).

## 6.5 Immutability triggers

```sql
CREATE FUNCTION deny_record_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'This record is immutable; create a new version or replacement instead';
END;
$$;
-- BEFORE UPDATE OR DELETE … FOR EACH ROW on: invoice_history, audit_events, export_batches,
-- purchase_orders, delivery_records, suppliers
```

Two independent layers protect these six tables:

1. the **trigger** (applies even to the table owner, until someone drops it), and
2. the **runtime role has no `UPDATE`/`DELETE` privilege** on them ([§6.8](#68-database-roles-and-privileges)).

Limits of the protection: `TRUNCATE` is not a row-level operation, so the trigger does not stop it (the
runtime role simply lacks the privilege; the owner/superuser could still truncate). The test suites truncate
tables as the owner between tests. Tamper-**evidence** (hash chains, external log shipping) is not provided
([§8.13](./08-security.md#813-known-gaps-and-residual-risks)).

## 6.6 Documents

- Stored in `invoices.document` as `bytea`, with `source_name`, `source_type` and a size `CHECK` of
  1 byte – 10 MiB (the API additionally requires ≥ 12 bytes and verifies the real file type).
- Listing and detail queries **never read the bytes**; they select only `octet_length(document)` as
  `sourceFile.size`. Bytes are read only by `GET /invoices/:id/document`.
- A document can be attached **only when the invoice is created**; there is no endpoint to replace or remove
  it, and snapshots record only name/type/size.
- Uploads are buffered in memory (Multer memory storage, 10 MiB cap) and written within the creating
  transaction, so an invoice and its document are atomic.
- Storing files in the database keeps backup, restore and consistency simple at the cost of database growth;
  object storage is a roadmap item ([§13](./13-limitations-and-roadmap.md#133-roadmap-suggestions)).

## 6.7 Migrations

**Files.** `server/migrations/NNN_name.sql`, where the name must match `^\d+_[a-z_]+\.sql$`.
Two consequences worth knowing:

- Files that do **not** match (uppercase letters, hyphens, digits after the first underscore…) are
  **silently ignored**.
- Files are applied in **lexicographic** order, so always use zero-padded numbers (`001`, `002`, …, `010`).

**Runner** (`migrate()`):

1. Take advisory lock `(20261002, 0)` inside a transaction.
2. `CREATE TABLE IF NOT EXISTS schema_migrations …`.
3. For each file, in order: if it is already recorded, its stored **checksum must equal** the file's SHA-256 —
   otherwise abort with "Applied migration … was modified"; if it is not recorded, execute it and record
   `(name, checksum)`.
4. Commit. **All pending migrations apply in one transaction: all or nothing.** (So statements that cannot
   run inside a transaction, such as `CREATE INDEX CONCURRENTLY`, are not supported by this runner.)

**Startup check** (`requireCurrentSchema`): `schema_migrations` must exist and contain **every migration file
the code ships, with matching checksums**. It does *not* complain about extra rows, so running an **older
application image against a newer database is not detected**; roll back with a restored backup or a
forward-fix migration, not by redeploying old code.

**Rules for authors**

- Never edit an applied migration (the checksum check will stop the next start). Add a new file.
- There are no automatic down-migrations.
- New tables are **not** readable by the runtime role until provisioning runs again: there are no default
  privileges. The production migrate job runs `migrate` *and* `provision-app` on every deploy, which grants
  `SELECT` on all tables, but **write privileges must be added** explicitly to `provisionAppRole`.
- `scripts/copy-assets.mjs` copies the SQL into the compiled output; no extra build step is needed.

## 6.8 Database roles and privileges

| Role | Created by | Used by | Notes |
| --- | --- | --- | --- |
| **`invoice_owner`** | The Postgres image from `POSTGRES_USER` — the cluster's **bootstrap superuser** | Migrate job, administrators, backups | Holds ownership and bypasses everything. The running API never receives its password |
| **`invoice_app`** | `provision-app` (idempotent) | The API process | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`; password from `APP_DATABASE_PASSWORD` (exactly 64 hex characters) |

`provisionAppRole` runs in one transaction under advisory lock `(20261002, 2)`: create the role if missing,
**re-assert its attributes and password**, `GRANT CONNECT` and `USAGE` on the schema, `REVOKE ALL` on all
tables, then re-grant exactly:

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | :---: | :---: | :---: | :---: |
| `users`, `invoices` | ✔ | ✔ | ✔ | – |
| `sessions`, `rate_limits` | ✔ | ✔ | ✔ | ✔ |
| `suppliers`, `purchase_orders`, `delivery_records` | ✔ | ✔ | – | – |
| `export_batches`, `invoice_history`, `audit_events` | ✔ | ✔ | – | – |
| `schema_migrations` | ✔ | – | – | – |

No `TRUNCATE`, `REFERENCES`, `TRIGGER` or `CREATE` privileges are granted (and PostgreSQL 15+ no longer lets
ordinary roles create objects in `public`). Because the grants are re-applied from scratch on every run,
re-running `provision-app` is also the way to **rotate the runtime password** or repair drift. The permission
tests prove both that the full workflow works under this role and that deletes, audit rewrites and DDL are
refused.

## 6.9 Connections, transactions and timeouts

| Setting | Value | Where |
| --- | --- | --- |
| Pool size | 10 | `createPool` |
| Connect timeout | 5 s | `connectionTimeoutMillis` |
| Idle connection timeout | 30 s | `idleTimeoutMillis` |
| `statement_timeout` | 15 s | per connection |
| `idle_in_transaction_session_timeout` | 15 s | per connection |
| `application_name` | `invoice-exception-assistant` | visible in `pg_stat_activity` |
| Isolation level | PostgreSQL default (**READ COMMITTED**) | correctness comes from the global lock, not from stronger isolation |

`transaction(pool, fn)` runs `BEGIN` / `COMMIT` and `ROLLBACK` on any error. `workflow()` adds the global lock
and actor re-check ([§5.5](./05-invoice-lifecycle.md#55-concurrency-control)). Date columns are returned as
strings (`pg.types.setTypeParser(1082, …)`) so a time-zone setting cannot shift a calendar date.

## 6.10 Querying: pagination, search and sorting

- **Pagination:** `LIMIT`/`OFFSET` with a separate `count(*)`. Every list has a **stable tie-breaker** (`id`),
  so pages do not overlap or skip when sort keys tie. Page size ≤ 100, page ≤ 100,000. Deep offsets get slower
  (keyset pagination is on the roadmap).
- **Search:** `ILIKE` with the user's text wrapped in `%…%` after **escaping `\`, `%` and `_`**, so users search
  for literal text (searching for `%` finds only a literal percent sign). Invoices match on invoice number,
  supplier name or PO number; suppliers on name or code; POs and receipts on their numbers.
- **Sorting:** the client sends a name from a fixed enum (`date_desc`, `date_asc`, `amount_desc`,
  `supplier`) which the server maps to a hard-coded `ORDER BY` fragment; SQL text from the client is never used.
  Nulls sort last.
- **All values are bound parameters.** The only interpolated SQL is a fixed internal table/column map for the
  three reference lists and the whitelisted sort fragment.
- A page of invoices costs two queries (rows + count) plus four context queries for rule evaluation.

## 6.11 Seeding

`npm run db:seed` (`seed-demo`) loads the [sample dataset](./03-domain-model.md#312-sample-dataset) inside one
`workflow()` transaction run by an **existing administrator** (`ADMIN_EMAIL`). It refuses to run when
`NODE_ENV=production` or when any supplier or invoice already exists, and records a `demo_seeded` audit event.
Seeded invoices carry a synthetic `request_fingerprint` and history entries stating that they came from the
seed command.

## 6.12 Backup, restore and retention

Everything — including documents and exported CSVs — is in this one database, so a consistent logical or
physical backup of it is a complete backup. Back up the private configuration (`.env.production`) and, if you
rely on it, Caddy's certificate volume separately. Step-by-step commands, a restore drill, and the warning to
revoke restored sessions are in [`docs/operations.md`](../docs/operations.md); the operating model is in
[§12.3](./12-operations.md#123-backup-restore-and-recovery).

There is **no automatic retention or purge**. Define retention, legal-hold and erasure policy before
collecting regulated data.

## 6.13 Useful read-only queries

For auditors and operators with database access (use a read-only role; never modify rows by hand):

```sql
-- Who approved what, newest first
SELECT h.timestamp, i.invoice_number, h.version, h.actor_name, h.detail
FROM invoice_history h JOIN invoices i ON i.id = h.invoice_id
WHERE h.action = 'approved'
ORDER BY h.timestamp DESC LIMIT 50;

-- Invoices released in one export batch
SELECT i.invoice_number, i.total_cents / 100.0 AS total
FROM invoices i WHERE i.export_batch_id = '<batch id>' ORDER BY i.invoice_number;

-- Workflow status counts
SELECT status, count(*) FROM invoices GROUP BY status ORDER BY status;

-- Active sessions per user (never select token_hash or csrf_token into shared output)
SELECT u.email, count(*) AS active_sessions
FROM sessions s JOIN users u ON u.id = s.user_id
WHERE s.expires_at > now() GROUP BY u.email;
```
