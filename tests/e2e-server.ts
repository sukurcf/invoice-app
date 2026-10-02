import { spawn } from "node:child_process";
import pino from "pino";
import { startTestDatabase } from "./database.js";
import { createPool, migrate } from "../server/database.js";
import { hashPassword, publicUser, type UserRow } from "../server/auth.js";
import { seedDemo } from "../server/seed.js";

const database = await startTestDatabase();
const pool = createPool(database.url, pino({ level: "warn" }));
let child: ReturnType<typeof spawn> | undefined;
let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
  }
  await pool.end();
  await database.stop();
}
try {
  await migrate(pool);
  const hash = await hashPassword("E2e-only-passphrase-123!");
  const { rows } = await pool.query<UserRow>(`INSERT INTO users(id,email,name,password_hash,role,must_change_password) VALUES
    ('e2e-admin','admin@example.test','Alex Admin',$1,'admin',false),
    ('e2e-reviewer','reviewer@example.test','Taylor Reviewer',$1,'reviewer',false) RETURNING *`, [hash]);
  const administrator = rows.find((user) => user.id === "e2e-admin");
  if (!administrator) throw new Error("Could not bootstrap test administrator.");
  await seedDemo(pool, publicUser(administrator));
  child = spawn(process.execPath, ["build/server/index.js"], {
    stdio: "inherit", env: { ...process.env, NODE_ENV: "test", DATABASE_URL: database.url, PORT: "4173", HOST: "127.0.0.1", APP_ORIGIN: "http://127.0.0.1:4173", LOG_LEVEL: "warn" },
  });
  child.once("error", (error) => {
    console.error(error);
    void cleanup().finally(() => { process.exitCode = 1; });
  });
  child.once("exit", (code) => {
    if (!stopping) void cleanup().finally(() => { process.exitCode = code ?? 1; });
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    void cleanup().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  });
} catch (error) {
  await cleanup();
  throw error;
}
