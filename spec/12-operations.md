# 12. Operations

> Part of the [Invoice Exception Assistant specification](./README.md). Applies to version **1.0.0**.

This document explains the *operating model*: what runs, how to see its health, what to back up, what can go
wrong, and how the design limits capacity. The exact commands for deployment, upgrades, backups and restore
drills are in [`docs/operations.md`](../docs/operations.md); they are not repeated here.

## 12.1 Operating model

- **What runs:** four containers on one host (`db`, one-shot `migrate`, `app`, `proxy`) — see
  [§10.4](./10-configuration-and-deployment.md#104-production-topology).
- **What is stateful:** three named Docker volumes, of which two matter — `production_database` (everything the
  business owns) and `caddy_data` (TLS certificates and ACME account). The third, `caddy_config`, holds Caddy's
  autosaved configuration and is disposable. The application containers are disposable.
- **Who needs access:** an *operator* with shell access to the host and Docker (deploys, backups, CLI,
  database access) and *administrators* inside the application (accounts and reference data). Keep these groups
  small — operators can bypass every application control ([§8.13](./08-security.md#813-known-gaps-and-residual-risks)).
- **Availability:** a single host and a single database. There is **no high availability, automatic failover,
  or point-in-time recovery** in the supplied stack. Plan downtime for upgrades and restores.

## 12.2 Observability

### Health endpoints

| Endpoint | Meaning | Use for |
| --- | --- | --- |
| `GET /api/health/live` | The Node process is up and routing | Liveness |
| `GET /api/health/ready` | `SELECT 1` succeeds against PostgreSQL; otherwise **503 `NOT_READY`** (no detail exposed) | Readiness; external uptime monitoring |

The image declares a Docker `HEALTHCHECK` on the readiness endpoint, and Compose makes `proxy` wait for it.
**Docker does not restart a container merely because it is `unhealthy`** — an external monitor must watch
`/api/health/ready` (or `docker compose ps`) and alert a human.

### Logs

Pino writes **one JSON object per line to stdout**; read it with `docker compose logs app`. Standard fields are
`level` (numeric: 30 info, 40 warn, 50 error, 60 fatal), `time` (epoch ms), `pid`, `hostname`, `msg`.

```json
{"level":30,"time":1790923665833,"requestId":"41ebb81c-…","method":"POST","path":"/api/invoices/…/review","status":200,"durationMs":38,"userId":"9d0c…","msg":"request"}
{"level":50,"time":1790923681002,"requestId":"…","error":{"name":"error","message":"canceling statement due to statement timeout","stack":"…"},"msg":"Request failed"}
{"level":30,"time":1790923600000,"host":"0.0.0.0","port":3000,"msg":"Invoice service ready"}
```

| `msg` | Level | Meaning |
| --- | :---: | --- |
| `request` | info | Every finished request: ID, method, path (**no query string**), status, duration, user ID |
| `Request failed` | error | An unexpected (500) error, with stack — the client only saw a generic message and the `requestId` |
| `Readiness check failed` | warn | The database could not be reached by the readiness probe |
| `Invoice service ready` | info | Startup complete |
| `Unexpected idle database connection error` | error | A pooled connection broke while idle |
| `Expired session cleanup failed` | error | The hourly purge could not run |
| `Shutting down`, `Graceful shutdown timed out`, `Shutdown failed`, `HTTP server failed` | info / error / fatal | Lifecycle events |

**Correlating a user's report:** every error that came from the server ends, in the UI, with
`Request ID: <uuid>`; search the logs for that value. (Errors raised in the browser itself — a lost connection or
a form-validation message — have no request ID.) Passwords, cookies, CSRF tokens, bodies and document contents are
never logged, and the application does not log client IP addresses.

**Retention and rotation are not configured.** Docker's default `json-file` driver does not rotate logs; set
`max-size`/`max-file` (daemon-wide or per service in Compose) or ship logs elsewhere before the disk fills.

### What to alert on

| Signal | Suggested trigger |
| --- | --- |
| Readiness failing | External probe of `/api/health/ready` failing for 2+ minutes |
| 5xx responses | Any `level:50 … "Request failed"`, or `status ≥ 500` request lines above baseline |
| Authentication abuse | A burst of `status:429` or `401` on `/api/auth/login` |
| Certificate expiry | Less than 14 days remaining (Caddy renews automatically well before this) |
| Database health | Free disk, connection count, long-running or idle-in-transaction sessions |
| Backups | Age of the newest verified backup; failed restore drills |
| Containers | Restarts, OOM kills (the API has a 512 MiB limit) |
| Host | Disk (logs, volumes), memory, patch level |

### Diagnostic queries (read-only, as the owner)

```sql
-- Application connections by state
SELECT state, count(*)
FROM pg_stat_activity WHERE application_name = 'invoice-exception-assistant' GROUP BY state;

-- Who holds or waits for the global workflow lock (verified: classid = 20261002, objid = 1)
SELECT a.pid, a.state, l.granted, now() - a.xact_start AS txn_age, left(a.query, 80) AS query
FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory' AND l.classid = 20261002 AND l.objid = 1
ORDER BY l.granted DESC, a.xact_start;
```

## 12.3 Backup, restore and recovery

**What to back up**

| Item | Why | Notes |
| --- | --- | --- |
| The PostgreSQL database | Contains **everything**: invoices, document bytes, history, audit, accounts, export CSVs | A consistent logical (`pg_dump`) or physical backup is complete. Treat dumps as **highly sensitive**: they contain finance documents, password hashes and session rows |
| `.env.production` | Secrets and the domain | Store encrypted, separately from the database backup |
| `caddy_data` volume | Certificates and ACME state | Optional; Caddy can obtain new certificates, subject to rate limits |

**Guidance** (the stack does not schedule any of this):

- Choose a recovery-point objective and schedule dumps accordingly; copy them **off the host**, encrypted.
  A host-local dump is not disaster recovery.
- **Verify** each dump (`pg_restore --list`) and **rehearse a full restore** on a staging copy periodically,
  recording the elapsed time. An untested backup is a hope, not a backup.
- For tighter objectives than daily dumps, add WAL archiving / point-in-time recovery — **not** configured here.

**After any restore**

1. Restore into a **new** database and verify counts, history, a document download and a CSV before cutover.
2. **Revoke every session:** `DELETE FROM sessions;` (restored sessions may belong to users since disabled).
3. Provision the runtime role and migrations with the owner credentials (`migrate`, `provision-app`).
4. **Reconcile exports.** The restored data may predate batches that were already imported by another system;
   check before exporting anything again.
5. Keep the old database until reconciliation and rollback retention are satisfied.

**Recovery scenarios**

| Situation | Recovery |
| --- | --- |
| Bad deployment | Restore the pre-release backup and redeploy the **matching** version. Older code against a newer schema is not detected ([§6.7](./06-data-and-persistence.md#67-migrations)) |
| Database volume lost or corrupted | Restore the latest verified backup into a new volume; revoke sessions; reconcile |
| Host lost | New host → deploy the stack → restore the database and `.env.production`; DNS cutover; certificates re-issue automatically |
| Accidental data change by an operator | Restore to a side database and copy back *specific* rows by hand — the application has no undo |
| Lost administrator access | See [§12.6](#126-incident-playbooks) |

## 12.4 Routine operations

| Task | How |
| --- | --- |
| Add a user, change role, disable/enable, set a temporary password | **Team access** (administrators). Each action revokes the user's sessions and is audited |
| Add suppliers, POs, receipts | **Reference data** (administrators). Immutable; corrections are replacements |
| Review who did what | Invoice history on each invoice; administrative audit on **Team access** |
| Create the first administrator / recover access with no administrator | CLI `create-admin` / `reset-password` ([§10.8](./10-configuration-and-deployment.md#108-cli-reference)) |
| Upgrade the application | Backup → build → `migrate` → `up -d` → verify ([`docs/operations.md`](../docs/operations.md)) |
| Rotate the runtime database password | New 64-hex value in `.env.production` → run the migrate job (re-provisions the role) → recreate `app` |
| Rotate the owner (superuser) password | Change it **in PostgreSQL** deliberately, then update `.env.production` — changing the env var alone does not alter an existing volume's password |
| Force everyone to sign in again | `DELETE FROM sessions;` (owner) |
| Check migration state | `SELECT name, applied_at FROM schema_migrations ORDER BY name;` |

## 12.5 Capacity and scaling

The design targets **a small finance team** (tens of users, not thousands of concurrent writers).

| Factor | Behavior | Consequence |
| --- | --- | --- |
| **Global write lock** | All finance writes are serialized (`pg_advisory_xact_lock(20261002, 1)`) | Write throughput equals one transaction at a time. Adding API replicas does **not** increase write throughput (it does add read capacity) |
| **Lock waits** | A waiting request is bounded by the 15 s `statement_timeout`. **Observed:** with the lock held elsewhere, an approval returned `500 INTERNAL_ERROR` after 15.0 s; the invoice and history were unchanged and a retry after release succeeded | Occasional 500s under contention are *safe to retry*. A long-lived transaction or manual session holding the lock stalls every writer — find it with the diagnostic query above |
| **Connection pool** | 10 connections per API process, 5 s to obtain one | Writers waiting on the lock each hold a connection, so a burst can also delay *reads* |
| **Password hashing** | scrypt is CPU- and memory-heavy (~32 MiB per hash); a password *change* hashes while holding the global lock | Sign-ins and changes are intentionally slow; many simultaneous sign-ins use CPU |
| **Uploads** | Buffered in memory, ≤ 10 MiB each, within a 512 MiB container limit | Limit concurrent intake and watch memory; raise the limit if staff upload large files in bursts |
| **Database growth** | Documents and CSVs are stored in the database; history snapshots grow with every version | Size the volume for documents; backups and restores grow accordingly |
| **Search** | `ILIKE '%…%'` scans | Fine for tens of thousands of invoices; revisit with an index strategy beyond that |
| **Deep pagination** | `OFFSET` pagination | Very deep pages slow down |
| **Rate-limit counters** | Written to PostgreSQL on login/mutations | Extra write load; purged hourly |

**Scaling options, in order:** give the database more CPU/disk; tune PostgreSQL; raise the API memory limit;
move documents to object storage (roadmap); only then consider reducing the scope of the global lock
(a code change with real correctness implications — see [§5.5](./05-invoice-lifecycle.md#55-concurrency-control)).
Run a load test on your hardware with realistic data before relying on any figure.

## 12.6 Incident playbooks

| Situation | First checks | Action |
| --- | --- | --- |
| **Site unreachable / TLS error** | `docker compose ps`; `logs proxy`; DNS; ports 80/443; firewall; `caddy_data` volume present | Fix DNS/ports; restart `proxy`; certificates are obtained automatically once reachable |
| **`app` unhealthy / readiness 503** | `logs app` for `Readiness check failed`; `db` container health; disk space; credentials | Restore the database connection; if `migrate` failed, the app never started — read its logs |
| **App refuses to start: schema message** | Message says migrations missing or modified | Run the migrate job; never edit an applied migration |
| **Spike of 500 / "statement timeout"** | Lock-holder query (§12.2); long transactions; backups or manual sessions holding locks | Let the holder finish, or `pg_terminate_backend(pid)` if safe; users can retry |
| **Cannot sign in (one user)** | Disabled? Throttled (429 with `Retry-After`)? Temporary password pending? | Administrator re-enables / resets the password; throttling expires within 15 minutes |
| **No administrator can sign in** | — | CLI `reset-password` for an *active* admin. If every administrator is **disabled**, the CLI does not re-enable them: a database operator must set `active = true` on one account directly in SQL and record the change in your own change log (it is not audited by the application) |
| **Suspected credential or session compromise** | Audit and history for the time window; host logs | Disable/reset affected accounts; `DELETE FROM sessions;`; rotate both database secrets; review exports created in the window |
| **A wrong export was imported downstream** | `Export history` for the batch and its invoices | Exported invoices are final and cannot be re-exported. Correct it in the downstream system or by your finance process; enter a replacement invoice if needed |
| **Disk full** | Docker logs, database volume, backups on the host | Free space (rotate logs, move backups off-host); never delete database files by hand |
| **Corruption or data loss** | — | Restore ([§12.3](#123-backup-restore-and-recovery)) |

## 12.7 Maintenance

- **Automatic:** an hourly timer deletes expired sessions and rate-limit counters; PostgreSQL autovacuum runs
  with defaults; Caddy renews certificates.
- **Manual:** keep the host OS and Docker patched; rebuild images regularly (`docker compose build --pull`) to
  pick up base-image fixes; review Dependabot PRs and `npm audit`; rotate logs; test restores; review the
  administrator list; rotate secrets on staff changes.
- **PostgreSQL major upgrades** are not an image-tag change against an existing volume: use PostgreSQL's own
  dump/restore or `pg_upgrade` procedure.
- **Time:** keep the host clock synchronized; session expiry and certificates depend on it.

## 12.8 Data retention and privacy

The application keeps all invoices, documents, history, audit events and export batches **indefinitely** and has
no deletion or purge function. Accounts are disabled, never deleted. Before processing regulated or personal
data, decide: how long documents and history must (and may) be kept; how legal holds are applied; whether
erasure requests can be honored (they currently cannot, short of manual database work that would violate the
immutability design); who may access backups; and where backups are stored geographically. The application sends
no data to third parties.

## 12.9 Common symptoms

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `403 ORIGIN_REJECTED` for every write | Browser origin differs from `APP_ORIGIN` (scheme, host or port; `localhost` vs `127.0.0.1`) | Correct `APP_ORIGIN` or the URL used |
| Sign-in "works" but you are immediately signed out | Production cookie is `Secure`; the site is being used over plain HTTP, or a proxy strips HTTPS information | Serve HTTPS only; check the proxy |
| Everyone shares one rate-limit bucket | `TRUST_PROXY` is `0` behind a proxy (all clients appear to be the proxy's IP) | Set `TRUST_PROXY=1` when exactly one proxy hop fronts the API |
| Spoofable client IPs | `TRUST_PROXY=1` but the API is directly reachable | Do not publish the API port |
| UI shows "unexpected response" | A proxy returned HTML (error page) instead of JSON | Check proxy routing for `/api` |
| Approval blocked unexpectedly | Live exceptions (reservation by another approved invoice, a new duplicate, a rule change) | Open the invoice and read the evidence ([§4](./04-matching-and-exceptions.md)) |
| `409 VERSION_CONFLICT` | Someone else changed the invoice | Reload and reapply |
| Export saved but download failed | Network failure after the batch committed | Download from **Export history**; do not export again |
| `permission denied` after an upgrade | New table lacks write grants for the runtime role | Add the grants to `provisionAppRole`; rerun the migrate job |
| Docker Desktop unavailable locally | Engine stopped | Start it, or develop against any PostgreSQL; tests do not need Docker |
