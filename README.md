# Invoice Exception Assistant

A self-hosted accounts-payable workspace for **one finance team per deployment**.
React + TypeScript provide the UI; an Express API owns authentication, matching,
approvals, audit history, document storage, and exports in PostgreSQL.

This replaces the original in-memory demo. Production starts with an empty
workspace: there are **no default accounts, automatic demo records, public
registration, or browser-local finance records**.

**Full specification:** the [`spec/`](./spec/README.md) folder explains the whole
system — product, architecture, domain model, matching rules, invoice lifecycle,
data and persistence, API, security, frontend, deployment, testing, operations,
and known limitations.

## Features

- Administrator-created reviewer/admin accounts; forced first-use password
  changes, password recovery, account disabling, and session revocation.
- HttpOnly, same-site database-backed sessions; HTTPS-only production cookies,
  origin and CSRF checks, and shared database-backed rate limits.
- Server-paginated invoice search, status filters, sorting, dashboard counts,
  persistent URLs, mobile layouts, keyboard navigation, and explicit error/retry
  states.
- Manual drafts, optional PDF/PNG/JPEG documents, editable invoice fields,
  supplier/PO/receipt selection, and line-item entry.
- Server-side three-way matching: required fields, duplicate numbers, exact
  5% price tolerance, confidence checks, ordered quantities, and available
  received quantities.
- Approval is **blocked by every unresolved exception**, including for admins.
  Concurrent approvals cannot reserve the same quantities twice.
- Correction requests, escalation, reasoned voiding, and admin-only reopening
  of approved/unexported invoices.
- Optimistic version checks: stale changes fail rather than overwriting another
  reviewer's work.
- Immutable invoice snapshots, review history, administrative audit events, and
  server-generated CSV batches.
- Retry-safe draft creation and export requests; export history lets users
  recover failed downloads without exporting invoices again.
- Administrator screens for supplier, purchase-order, and goods-receipt setup.
- Docker deployment with PostgreSQL, automatic HTTPS through Caddy, non-root
  application containers, and a separate least-privilege runtime database role.

**Not connected:** OCR, AI, email, ERP, banking, or payment providers. A correction
request is an internal recorded action, not an email. An export creates a CSV,
not a payment or an ERP posting. Reference data must be entered manually or
through the authenticated API.

## Requirements

- Node.js **24.x**, npm, and PostgreSQL **18**.
- Docker Engine/Desktop with Compose v2 for the supplied deployment.
- For production: a DNS hostname pointing at the host and inbound ports 80/443.
- For browser tests: Playwright Chromium.

The lockfile is checked in. Use `npm ci`, not an unpinned dependency update, for
repeatable installs.

## Local development

### 1. Install and configure

```bash
nvm use
npm ci
cp .env.example .env
openssl rand -hex 32
```

Edit your new `.env` file using [the development example](./.env.example): put the generated password in both
`POSTGRES_PASSWORD` and the password portion of `DATABASE_URL`. These are two
literal values; dotenv does not expand `${VARIABLES}`. Never commit the real
environment file.

Start the development database and apply the versioned migrations:

```bash
docker compose -f compose.dev.yaml up -d --wait db
npm run db:migrate
```

An existing PostgreSQL instance is also supported: set `DATABASE_URL` accordingly
and omit the Docker command. If changing `PGPORT`, also change the port in
`DATABASE_URL`.

### 2. Create your administrator

Set `ADMIN_EMAIL`, `ADMIN_NAME`, and a unique 12-128 character `ADMIN_PASSWORD` in
the command's environment. For example, in Bash/zsh:

```bash
export ADMIN_EMAIL=you@example.com
export ADMIN_NAME="Your Name"
printf 'Administrator password: '
read -r -s ADMIN_PASSWORD
printf '\n'
export ADMIN_PASSWORD
npm run admin:create
unset ADMIN_PASSWORD
```

The password is hashed using salted scrypt and is never printed by the CLI.
Administrator bootstrap requires access to the database; there is no web
bootstrap endpoint. Rerunning with an existing email fails instead of resetting
its password.

### 3. Run the app

```bash
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` to the API on
`127.0.0.1:3000`. The exact browser origin must match `APP_ORIGIN`; do not switch
between `localhost` and `127.0.0.1` without updating it.

Sign in, add reference data, create reviewer accounts, and enter invoices.
Alternatively, explicitly load synthetic examples into an **empty development
workspace**:

```bash
export ADMIN_EMAIL=you@example.com
npm run db:seed
```

Seeding is transactional, refuses existing finance/reference data, and is
disabled when `NODE_ENV=production`. The old demo's browser state is not imported.

### 4. Review an invoice

1. Add a supplier, PO, and goods receipt in **Reference data**.
2. Use **New invoice** to save a manual or document-backed draft.
3. Open **Edit invoice** to verify fields and correct matching exceptions.
4. Approve only when all checks pass. A wrongly submitted duplicate can be
   voided with a reason; its history remains available.
5. In **Exports**, select approved records and create a CSV batch. The invoices
   become locked, and the exact CSV remains downloadable from export history.

## Production deployment

Full deployment, upgrade, backup, recovery, and incident procedures are in
[the operations guide](./docs/operations.md).

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Set:

- `APP_DOMAIN`: your real DNS hostname, without a scheme or trailing slash.
- `POSTGRES_PASSWORD`: a generated 64-character hexadecimal database-owner
  secret (`openssl rand -hex 32`).
- `APP_DATABASE_PASSWORD`: a **different** generated 64-character hexadecimal
  secret for the limited application role.

Then:

```bash
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
```

The migration job initializes the schema and runtime role before the app starts.
Caddy obtains TLS certificates for `APP_DOMAIN`. PostgreSQL and the app are not
published as host ports in the production configuration.

Create an administrator using the environment-variable procedure above, then:

```bash
docker compose --env-file .env.production exec \
  -e ADMIN_EMAIL -e ADMIN_NAME -e ADMIN_PASSWORD \
  app node build/server/cli.js create-admin
unset ADMIN_PASSWORD
```

Open `https://your-hostname`. Verify `/api/health/ready` returns
`{"status":"ok"}`, sign in, and complete a staging invoice/export before admitting
real users.

Do **not** use `vite preview`, the Vite development server, or development
database credentials for public hosting. Application secrets are server-only;
no `VITE_*` secret is needed.

## Configuration

| Variable | Purpose / default |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL; server-side only. Use verified TLS for remote database connections. |
| `NODE_ENV` | `development`, `test`, or `production`; production requires an HTTPS origin. |
| `APP_ORIGIN` | Exact browser origin, including a nonstandard port when needed. Development default: `http://localhost:5173`. No trailing slash. |
| `HOST` / `PORT` | API bind address/port, default `127.0.0.1:3000`. Containers use `0.0.0.0`. |
| `TRUST_PROXY` | `0` direct or `1` exactly one trusted reverse proxy. Never expose the API directly when trusting a proxy. |
| `SESSION_HOURS` | Absolute session lifetime, 1-24 hours; default 8. Each login creates a new server-generated session (earlier sessions stay valid until they expire or are revoked); password changes and administrator access changes revoke a user's sessions. |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info`, `debug`, or `silent`; default `info`. |
| `APP_DOMAIN` | Production Compose/Caddy hostname. Compose derives `APP_ORIGIN` from it. |
| `POSTGRES_PASSWORD` | Docker database-owner credential. Not provided to the running production app. |
| `APP_DATABASE_PASSWORD` | Production runtime-role credential; 64 hexadecimal characters. |
| `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD` | Transient bootstrap/recovery CLI inputs, not application defaults. |
| `TEST_DATABASE_URL` | Optional disposable test-cluster administrator URL; role-provisioning tests require superuser privileges. Never point it at production. |

## Tests and quality gates

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run test:integration:coverage
npx playwright install chromium
npm run test:e2e
```

`npm run check` runs lint, production build/type-check, and both coverage gates.
`npm run test:all` runs the unit/UI, API, and browser suites. See
[the test guide](./docs/testing.md) for scope, thresholds, fixtures, isolation, and
troubleshooting.

API tests run against a real, isolated PostgreSQL database, not an in-memory
replacement. By default the test dependency starts an ephemeral local PostgreSQL
cluster with generated credentials and cleans it up. No Docker daemon is needed.
The browser suite exercises the compiled production bundle and API.

[GitHub Actions](./.github/workflows/ci.yml) runs the quality gates, browser tests,
production dependency audit, Compose validation, and container build/startup checks on
every push to `main` and on every pull request. It does not deploy automatically.

## Architecture

```text
Browser --HTTPS--> Caddy --> Express API + built React assets
                              |
                              +-- PostgreSQL
                                  users / sessions / rate limits
                                  suppliers / POs / receipts
                                  invoices + document bytes
                                  immutable history / audit / CSV batches
```

- [Shared domain](./src/domain/) defines types and strict input validation.
- [Matching rules](./src/services/invoiceChecks.ts) are used on the server and
  tested independently; the browser cannot bypass them.
- [API routes](./server/app.ts), [workflow operations](./server/invoices.ts), and
  [database transactions](./server/database.ts) own all mutations.
- [Versioned migrations](./server/migrations/) are applied explicitly, under a
  database lock, with checksums. Never edit an applied migration.
- [React state](./src/state/appState.tsx) stores session/UI state in memory only,
  aborts obsolete requests, and clears protected views on session expiry.

The API contract and status transitions are described in
[the API/workflow guide](./docs/api.md). For a complete explanation of every part
of the system, including the design reasoning, start with
[the specification](./spec/README.md).

## Supported boundaries and launch checklist

This is an operational baseline for a small, trusted internal finance team,
not a certification of compliance or an unlimited-scale ERP.

- One deployment is one shared team; every active user can access its invoices,
  documents, and exports. There is no multi-tenancy or per-supplier segregation.
- USD only; prices/tax have at most two decimals; whole-unit quantities; one PO
  and one goods receipt per invoice; 100 line items; total at most USD 100 million.
- Reference data is immutable. To correct a source reference, create the
  appropriate replacement reference set and relink an unapproved/reopened draft.
  A receipt's units count toward its PO even if no invoice uses it.
- Documents are at most 10 MiB and remain in PostgreSQL. Signature/type checks
  are **not antivirus scanning**. Only trusted staff should upload/download
  documents; add malware scanning/quarantine before accepting untrusted intake.
- Exported and voided invoices cannot be edited or deleted through the app.
  There are no credit-note, payment, tax-calculation, or reconciliation workflows.
- There is no MFA, SSO, emailed recovery, or separation-of-duties/two-person
  approval. Reviewers can approve their own drafts when checks pass. Add these
  controls if your organization's risk or regulatory requirements demand them.
- CSV download does not prove successful downstream import. Reconcile exports
  in your finance process. Preserve the immutable batch identifier.
- Logs are structured but an alerting/metrics/error-collection service is not
  configured. Monitor readiness, database capacity, failures, and backups.
- Before launch: verify HTTPS/DNS, unique secrets and restricted host access,
  least-privilege database access, encrypted backups, a restore drill, user-role
  policy, retention/legal requirements, and expected-volume load testing.
- Container base images and infrastructure patches must be maintained; pin
  reviewed image digests in your release environment. Never expose the database
  or reuse test credentials.

The app deliberately reports missing integrations and failed operations rather
than claiming an external action succeeded.
