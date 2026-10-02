import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function startTestDatabase(): Promise<{ url: string; stop: () => Promise<void> }> {
  const databaseName = `invoice_test_${randomUUID().replaceAll("-", "")}`;
  let adminUrl = process.env.TEST_DATABASE_URL;
  let engine: EmbeddedPostgres | undefined;
  let directory: string | undefined;
  const logs: string[] = [];
  try {
    if (!adminUrl) {
      directory = await mkdtemp(join(tmpdir(), "invoice-test-"));
      const port = await freePort();
      const password = randomBytes(24).toString("hex");
      engine = new EmbeddedPostgres({
        databaseDir: join(directory, "database"), user: "test_runner", password, port,
        persistent: false, createPostgresUser: false, authMethod: "scram-sha-256",
        postgresFlags: ["-h", "127.0.0.1"],
        onLog: (message) => { logs.push(message); },
        onError: (message) => { logs.push(String(message)); },
      });
      await engine.initialise();
      await engine.start();
      adminUrl = `postgresql://test_runner:${password}@127.0.0.1:${port}/postgres`;
    }
    const target = new URL(adminUrl);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try { await admin.query(`CREATE DATABASE "${databaseName}"`); }
    finally { await admin.end(); }
    target.pathname = `/${databaseName}`;
    const cleanupUrl = adminUrl;
    return {
      url: target.toString(),
      stop: async () => {
        if (engine) {
          await engine.stop();
        } else {
          const cleanup = new pg.Client({ connectionString: cleanupUrl });
          await cleanup.connect();
          try { await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); }
          finally { await cleanup.end(); }
        }
        if (directory) await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (engine) await engine.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
    throw new Error(`Could not start the isolated PostgreSQL test database.\n${logs.slice(-20).join("\n")}`, { cause: error });
  }
}
