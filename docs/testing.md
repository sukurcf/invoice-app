# Testing and quality gates

For the strategy, a per-file inventory of every test, and what is deliberately
not tested, see [the testing specification](../spec/11-testing-and-quality.md).

## Commands

| Command | Scope |
| --- | --- |
| `npm run typecheck` | Strict TypeScript for browser, server, configuration and tests. |
| `npm run lint` | ESLint, TypeScript and React hook rules. |
| `npm test` | Domain, HTTP transport, React state, component and screen tests. |
| `npm run test:watch` | Interactive unit/UI test runner. |
| `npm run test:coverage` | Unit/UI tests with enforced coverage thresholds. |
| `npm run test:integration` | HTTP/API workflows on real isolated PostgreSQL. |
| `npm run test:integration:coverage` | API tests plus enforced server coverage. |
| `npm run test:e2e` | Production build, isolated PostgreSQL/API server, Chromium UI tests. |
| `npm run test:all` | Unit/UI, API and browser tests. |
| `npm run check` | Lint, production build/type-check, both coverage gates. |

Use Node 24 and `npm ci`. For Chromium, run `npx playwright install chromium`;
Linux CI installs browser system dependencies with `--with-deps`.

Targeted examples:

```bash
npm test -- src/services/invoiceChecks.test.ts src/utils/csv.test.ts
npm run test:integration -- -t "concurrent approvals"
npx playwright test -g "reviewer mobile"
```

The last command assumes the current production build already exists. Prefer
`npm run test:e2e` after changing application code so stale bundles are not tested.

## Isolation and safety

The API and browser runners create an ephemeral PostgreSQL cluster with random
credentials, a random database name, and an isolated temporary directory. The
API suite uses real HTTP requests, real transactions, real file bytes, real
password hashing, and PostgreSQL constraints/locks. It does not mock the database.

For systems without supported embedded binaries, set `TEST_DATABASE_URL` to a
**disposable PostgreSQL test cluster** administrator. The permission suite tests
database-role provisioning, including privileged role flags, and therefore needs
a test-cluster superuser. The runner creates and drops only a unique `invoice_test_*` database;
permission tests also create/drop a uniquely named test role. Never provide a
production connection URL. Tests clear tables only inside their generated test
database.

Embedded PostgreSQL must run as a non-root user. The harness will not create OS
users or change host permissions. Use a normal user or a disposable external test
cluster in root-only environments.

The browser suite owns `127.0.0.1:4173` and refuses to reuse an existing server.
It runs the actual compiled server and static React assets with `NODE_ENV=test`
because its local URL is HTTP. Separate API tests verify production HTTPS-only
configuration, Secure cookies, cookie prefix, HSTS and proxy settings.

Fixtures and passwords in tests are synthetic. Test credentials are not
production defaults. The API test harness removes the generated databases and
temporary files on normal completion; if a runner is forcibly killed, inspect
and clean up only its specific temporary paths, never a broad parent directory.

## Coverage gates

| Scope | Lines/statements | Functions | Branches |
| --- | --- | --- | --- |
| Domain + React workflows | 80% | 80% | 75% |
| Core server modules | 85% | 90% | 80% |

Thresholds fail the command/CI if unmet. Coverage is a guardrail, not a claim of
complete correctness. Startup/CLI lifecycle and deployment behavior are also
exercised by real-browser startup and explicit deployment checks, rather than
represented as unit coverage.

Reports are generated under `coverage/`, `coverage/api/`, `playwright-report/`,
and `test-results/`. These generated directories are ignored by Git. CI retains
reports for 14 days. Screenshots and traces use only generated test data; review
their sensitivity before enabling traces against a non-test environment.

## Test matrix

### Domain and validation

- Monetary calculations in integer cents, tax, zero values, and the exact total
  ceiling; no tolerance decision based on a rounded percentage.
- 5% price boundary, just-over tolerance, zero-price POs, unknown SKUs.
- Supplier + normalized invoice-number duplicates, including case/Unicode and
  whitespace; blank and voided records do not match.
- Required fields even with absent extraction metadata; confidence threshold;
  cross-linked PO/supplier/receipt rejection.
- Cumulative PO and receipt reservations across approved/exported invoices.
- Valid calendar dates/leap days, due-date ordering, finite nonnegative money,
  whole-unit quantities, line-count limits, duplicate normalized SKUs.
- Strict rejection of forged statuses, actors and unsupported input fields.
- CSV quoting, CR/LF, formula-neutralized text, exact totals, and export eligibility.

### Accounts and HTTP controls

- Absent, invalid and expired sessions; disabled accounts; cross-instance
  persistence; logout and revocation.
- Non-enumerating login failures, login throttling, password hashing, corrupt
  hash rejection, password length limits and reuse prevention.
- Forced first-use rotation; wrong-current-password behavior; admin resets.
- Reviewer/admin API and navigation restrictions; self-access-change prevention.
- Exact Origin checks, CSRF rejection, protected document/export downloads,
  no-store responses, production cookie/HSTS configuration.
- Bounded/malformed bodies, unsupported references and unknown routes;
  sanitized error responses with request IDs.

### Transactional workflows

- Incomplete drafts save but cannot be approved.
- Corrections persist and produce invoice snapshots with real actor names.
- Every existing exception blocks approval; notes required for non-approval
  actions; void/reopen/finalized-state rules.
- Optimistic concurrency conflicts do not append incorrect history.
- Concurrent approvals cannot over-reserve quantities.
- Idempotent creation/export retries, cross-account replay rejection, stale
  versions, duplicate export selections and export-time revalidation.
- Audit/reference/export immutability, SQL role privileges, migration
  idempotency/checksums and safe seed boundaries.
- Authenticated document byte persistence and content/type/size validation.

### UI and real-browser flows

- Authentication retry, session expiry, stale response cancellation and explicit
  network errors without fake success.
- Search/filter/sort/pagination, empty workspace onboarding, missing records.
- Draft editing, PO-line import, required reasons, save failures, version
  conflicts, upload validation and object-URL cleanup.
- Unsaved-change protection on route navigation and browser close.
- Approval controls, source downloads, saved snapshots and history paging.
- Export selection, retained batches, retry behavior, failed-download recovery.
- Account, supplier, PO and receipt administration.
- Full fresh-reference-to-upload-to-correction-to-approval-to-export workflow
  using the production bundle and PostgreSQL.
- Provisioned reviewer's forced password change and session invalidation.
- Chromium desktop and 390px mobile layout; navigation, reload/deep links,
  exception enforcement, and document-width overflow check.

## Before a release

1. Run `npm run check` and `npm run test:e2e`.
2. Run `npm audit --omit=dev --audit-level=high` and review dependency upgrades.
3. Validate Compose, build the production image, and exercise HTTPS in staging.
4. Restore a backup, compare invoice/history/document/export data, and rehearse
   migration/recovery before applying the release to real records.
5. Load-test realistic record counts, upload concurrency, and review/export
   workload on target hardware.
6. Validate your required browsers, accessibility policy, security controls,
   retention policy, and organizational approval rules.

The automated suite is substantial regression coverage, not every possible
input, a penetration test, or a compliance certification.
