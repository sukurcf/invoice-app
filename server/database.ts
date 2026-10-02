import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import type { Logger } from "pino";
import { HttpError } from "./errors.js";
import type { User } from "../src/domain/types.js";

pg.types.setTypeParser(1082, (value) => value);
export type Database = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000, statement_timeout: 15_000, idle_in_transaction_session_timeout: 15_000,
    application_name: "invoice-exception-assistant",
  });
  pool.on("error", (error) => logger.error({ message: error.message }, "Unexpected idle database connection error"));
  return pool;
}

export async function transaction<T>(pool: pg.Pool, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function workflow<T>(pool: pg.Pool, actor: User, operation: (client: pg.PoolClient) => Promise<T>, admin = false): Promise<T> {
  return transaction(pool, async (client) => {
    // One team-wide write lock protects duplicate checks, quantity reservations, and exports across API replicas.
    await client.query("SELECT pg_advisory_xact_lock(20261002, 1)");
    const result = await client.query<{ active: boolean; role: User["role"]; must_change_password: boolean }>("SELECT active, role, must_change_password FROM users WHERE id = $1 FOR SHARE", [actor.id]);
    const current = result.rows[0];
    if (!current?.active) throw new HttpError(401, "SESSION_EXPIRED", "Your account is no longer active. Sign in again.");
    if (current.must_change_password) throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password before continuing.");
    if (admin && current.role !== "admin") throw new HttpError(403, "FORBIDDEN", "Administrator access is required.");
    return operation(client);
  });
}

async function migrationFiles() {
  const directory = new URL("./migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(new URL(name, directory), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const migrations = await migrationFiles();
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(20261002, 0)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const { rows } = await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations");
    for (const migration of migrations) {
      const applied = rows.find((row) => row.name === migration.name);
      if (applied && applied.checksum !== migration.checksum) throw new Error(`Applied migration ${migration.name} was modified. Restore it and add a new migration.`);
      if (!applied) {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)", [migration.name, migration.checksum]);
      }
    }
  });
}

export async function requireCurrentSchema(pool: pg.Pool): Promise<void> {
  const present = await pool.query<{ name: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS name");
  if (!present.rows[0]?.name) throw new Error("Database is not initialized. Run npm run db:migrate.");
  const { rows } = await pool.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations");
  for (const migration of await migrationFiles()) {
    if (!rows.some((row) => row.name === migration.name && row.checksum === migration.checksum)) {
      throw new Error("Database migrations are missing or modified. Run npm run db:migrate before starting the server.");
    }
  }
}

export async function provisionAppRole(pool: pg.Pool, password: string, role = "invoice_app"): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("APP_DATABASE_PASSWORD must be a 64-character hexadecimal secret.");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error("Invalid application database role name.");
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(20261002, 2)");
    await client.query("SELECT set_config('invoice.runtime_role', $1, true), set_config('invoice.runtime_password', $2, true)", [role, password]);
    await client.query(`DO $provision$
      DECLARE role_name text := current_setting('invoice.runtime_role');
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
          EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT', role_name);
        END IF;
        EXECUTE format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L', role_name, current_setting('invoice.runtime_password'));
      END $provision$`);
    const identifier = pg.escapeIdentifier(role);
    const { rows } = await client.query<{ name: string }>("SELECT current_database() AS name");
    await client.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(rows[0].name)} TO ${identifier}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${identifier}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${identifier}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${identifier}`);
    await client.query(`GRANT INSERT, UPDATE ON users, invoices TO ${identifier}`);
    await client.query(`GRANT INSERT, UPDATE, DELETE ON sessions, rate_limits TO ${identifier}`);
    await client.query(`GRANT INSERT ON suppliers, purchase_orders, delivery_records, export_batches, invoice_history, audit_events TO ${identifier}`);
  });
}
