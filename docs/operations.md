# Deployment and operations

See [the README](../README.md) for initial setup. This guide assumes a dedicated
Linux production host, Docker Compose v2, a real DNS hostname, and HTTPS. For the
operating model behind these runbooks (observability, capacity, incident
playbooks), see [the operations specification](../spec/12-operations.md).

## Deployment model

[Production Compose](../compose.yaml) has four services:

1. `db`: PostgreSQL 18, private network, persistent volume.
2. `migrate`: one-shot schema migrations and application-role grants. It receives
   the owner credential, then exits. Failure blocks application startup.
3. `app`: non-root Node 24, read-only filesystem, limited capabilities, 512 MiB
   memory limit, and the **limited `invoice_app` database role**.
4. `proxy`: Caddy, automatic HTTPS, request-size limit, and compression.

Only the proxy publishes host ports. `TRUST_PROXY=1` assumes exactly this single
proxy hop. Do not publish the app port or insert another proxy without reviewing
client-IP handling, rate limits, and trusted-proxy settings.

The app's database role can read required tables, mutate accounts/invoices and
sessions, and insert reference/audit/export records. It cannot alter schemas,
delete invoices, or update/delete immutable audit and reference tables. Tests
execute representative workflows under this role and verify those denials.

The database owner remains powerful. Host/Docker/database-owner access must be
restricted and independently audited. Application audit tables are not a
cryptographically signed or owner-proof ledger.

## Initial release

1. Install Docker and open inbound TCP 80/443; UDP 443 is optional for HTTP/3.
2. Point `APP_DOMAIN` DNS to the host.
3. Copy [the production environment example](../.env.production.example) to a
   private `.env.production` file, `chmod 600` it, and generate two distinct
   64-character hex secrets with `openssl rand -hex 32`.
4. Review and, for controlled releases, pin base-image digests. Package versions
   are already locked by [the npm lockfile](../package-lock.json).
5. Validate/build/start:

   ```bash
   docker compose --env-file .env.production config --quiet
   docker compose --env-file .env.production up -d --build
   docker compose --env-file .env.production ps
   docker compose --env-file .env.production logs --tail=100 migrate app proxy
   ```

6. Create the first administrator with the transient environment variables and
   CLI procedure in [the README](../README.md). There is no seeded password.
7. Verify HTTPS, login, source download, an exception rejection, approval, and
   CSV download in staging before processing real records.

Compose's `config --quiet` avoids printing resolved secrets. Do not attach
unredacted `docker inspect`, `docker compose config`, environment files, or SQL
connection URLs to support tickets.

Environment variables are convenient for this single-host example but visible
to privileged host/Docker operators. For your infrastructure, supply them from a
secret manager or inject an equivalent private environment at runtime.

## Health and logs

- `GET /api/health/live`: process liveness.
- `GET /api/health/ready`: database connectivity. Startup independently refuses
  missing or modified migrations.
- Failed readiness returns HTTP 503. Set external alerts; a Docker `unhealthy`
  state alone does **not** restart a running unhealthy container.
- JSON logs include request ID, method, path without query string, status,
  duration, and authenticated user ID. Request bodies, cookies, CSRF tokens,
  passwords, and uploaded document contents are not intentionally logged.
- Error responses include a request ID, not a stack or database diagnostic.
  Server-side unexpected errors are logged for investigation.
- `SIGTERM` stops accepting requests, drains the HTTP server, closes the database
  pool, and enforces a 10-second shutdown deadline.

Monitor 5xx responses, authentication failures, rate limits, readiness, database
disk growth, connection usage, CPU/memory, certificate renewals, and backup age.
Install an external log collector/alert system if required; none is silently
enabled by the app.

## Updates and migrations

Back up and rehearse the release on a restored staging database first.

```bash
docker compose --env-file .env.production build --pull
docker compose --env-file .env.production stop proxy app
docker compose --env-file .env.production run --rm migrate
docker compose --env-file .env.production up -d
```

The migration job also reapplies grants to include any newly added tables.
Changes to the schema and migration ledger are transactional. A database
advisory lock prevents two migrators from applying a migration simultaneously.
Applied SQL checksums are verified both during migration and application startup.

Always add a new numbered SQL migration; never modify an applied file. This
project does not ship destructive automatic down-migrations. Use a reviewed
forward fix or a tested backup restore when necessary. Database major-version
upgrades require PostgreSQL's own migration/restore procedure; do not merely
change the image major version against an existing data directory.

## Backups

All business data is in PostgreSQL, including original documents and exact CSV
exports. Back up the database, private configuration, and Caddy certificate data
under your organization's encryption and access policy.

Example logical backup, run on the deployment host:

```bash
umask 077
mkdir -p backups
docker compose --env-file .env.production exec -T db \
  pg_dump -U invoice_owner -d invoices --format=custom \
  > backups/invoices-2026-10-02.dump
docker compose --env-file .env.production exec -T db \
  pg_restore --list < backups/invoices-2026-10-02.dump
```

Use a unique filename for each run; do not overwrite the only good backup. Check
the dump command's exit status and test the resulting archive before retention
rotation. A host-local dump is not disaster recovery: encrypt and copy it to a
separately controlled backup destination. Configure scheduling and alerts for
your required recovery point objective. High availability and point-in-time
recovery/WAL archiving are not configured by this Compose example.

Never commit database dumps or backups. They contain private finance documents,
password hashes, and session information.

## Restore drill and recovery

Restore to a **new database**, not over the live one:

```bash
docker compose --env-file .env.production exec -T db \
  createdb -U invoice_owner invoices_restore
docker compose --env-file .env.production exec -T db \
  pg_restore -U invoice_owner --no-owner --no-privileges --exit-on-error \
  --dbname=invoices_restore < backups/invoices-2026-10-02.dump
docker compose --env-file .env.production exec -T db \
  psql -U invoice_owner -d invoices_restore -c \
  "SELECT count(*) AS invoices FROM invoices; SELECT count(*) AS events FROM invoice_history;"
```

Use a separate staging deployment connected to the restored database; provision
its application role, verify migration checksums, and check document downloads,
history, and CSV contents. Rehearse this periodically and record elapsed recovery
time. Do not send real restored finance data to third-party test services.

Before a production cutover, stop writers and have a reviewed rollback plan.
The restored database may predate a CSV that was already imported elsewhere:
reconcile external imports before exporting again. Revoke restored sessions:

```sql
DELETE FROM sessions;
```

Point the deployment at the verified database, run the correct migration/role
provisioning commands using the owner connection, and restart the app. Preserve
the old database until reconciliation and rollback-retention requirements are
met. Never run `docker compose down -v` against production; that deletes volumes.

## Account recovery and credential rotation

Administrators can set another user's temporary password in **Team access**.
The user must replace it at next login; existing sessions are revoked. For
recovery when no administrator can sign in, set `ADMIN_EMAIL` and
`ADMIN_PASSWORD` using the private input procedure from the README, then:

```bash
docker compose --env-file .env.production exec \
  -e ADMIN_EMAIL -e ADMIN_PASSWORD app \
  node build/server/cli.js reset-password
unset ADMIN_PASSWORD
```

Recovery does not reactivate a disabled account. Use another active administrator
or a documented database-operator procedure. User actions cannot disable/demote
the signed-in administrator.

To rotate the runtime database secret: generate a new hex value, update
`.env.production`, stop app/proxy, run the migration job to update the role's
password/grants, and recreate app/proxy. Changing `POSTGRES_PASSWORD` in Compose
does **not** change the owner password in an existing PostgreSQL volume: perform
a deliberate database-owner password rotation and update the private
configuration together.

## Capacity and operational boundaries

- SQL lists and audit history are paginated, with a maximum page size of 100.
- One transaction-wide team lock serializes finance mutations so duplicate
  checks, quantity reservations, and exports remain correct across replicas.
  This intentionally favors correctness over very high write throughput.
- Each document is limited to 10 MiB; binary data and backups grow with usage.
  The API buffers a bounded upload in memory. Restrict intake to trusted staff,
  monitor memory/disk, and load-test the planned concurrent workload.
- Reference records and exported/voided invoices have no deletion workflow.
  Define retention, legal hold, archival, and privacy-erasure procedures before
  collecting personal or regulated data.
- No antivirus, SSO/MFA, two-person approval, intrusion detection, ERP sync, or
  compliance certification is implied. Integrate required organizational
  controls before public or high-risk deployment.
- The current application can run multiple API instances against one database,
  but the provided Compose stack is **single-host**, not highly available.

## Common failures

| Symptom | Check |
| --- | --- |
| Origin rejected | Browser scheme/host/port must exactly match `APP_ORIGIN`; HTTPS is mandatory in production. |
| Login works but cookies are absent | Check HTTPS and proxy topology. Secure production cookies are not sent over plain HTTP. |
| App refuses startup | Run migrations with owner permissions; check checksum mismatch and database connectivity. |
| Permission denied after an upgrade | Rerun `provision-app` through the migration service with owner credentials. |
| Approval blocked | Inspect every exception; missing data, duplicates, confidence and already-reserved quantities all block approval. |
| Version conflict | Reload the invoice, reconcile changes, and submit against the current version. |
| Export saved but download failed | Download the retained batch from **Export history**; do not create a replacement batch. |
| Login rate limited | Honor `Retry-After`; investigate repeated failures. Counters are shared and expire automatically. |
| PDF does not preview | PDFs deliberately download as attachments; they are not embedded as active content. |
| Docker unavailable locally | Use an existing PostgreSQL server for development; isolated tests do not require Docker. |
