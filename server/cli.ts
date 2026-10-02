import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import pino from "pino";
import { loadConfig } from "./config.js";
import { createPool, migrate, provisionAppRole, transaction } from "./database.js";
import { hashPassword, publicUser, type UserRow } from "./auth.js";
import { createUserSchema, emailSchema, passwordSchema } from "../src/domain/validation.js";
import { appendAudit } from "./repository.js";
import { seedDemo } from "./seed.js";

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, pino({ level: config.logLevel }));
  try {
    if (command === "migrate") {
      await migrate(pool);
      console.log("Database migrations are current.");
    } else if (command === "provision-app") {
      await provisionAppRole(pool, process.env.APP_DATABASE_PASSWORD ?? "");
      console.log("Least-privilege application database role provisioned.");
    } else if (command === "create-admin") {
      const input = createUserSchema.parse({ email: process.env.ADMIN_EMAIL, name: process.env.ADMIN_NAME, password: process.env.ADMIN_PASSWORD, role: "admin" });
      const hash = await hashPassword(input.password);
      await transaction(pool, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(20261002, 1)");
        const id = randomUUID();
        await db.query("INSERT INTO users(id,email,name,password_hash,role,must_change_password) VALUES ($1,$2,$3,$4,'admin',false)", [id, input.email, input.name, hash]);
        await appendAudit(db, { id: null, name: "Operator CLI" }, "admin_bootstrapped", id, "Administrator account created by a database operator.");
      });
      console.log("Administrator created. No default credentials were installed.");
    } else if (command === "reset-password") {
      const email = emailSchema.parse(process.env.ADMIN_EMAIL);
      const hash = await hashPassword(passwordSchema.parse(process.env.ADMIN_PASSWORD));
      await transaction(pool, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(20261002, 1)");
        const result = await db.query<{ id: string }>("UPDATE users SET password_hash=$2, must_change_password=true WHERE email=$1 RETURNING id", [email, hash]);
        if (!result.rows[0]) throw new Error("Account not found.");
        await db.query("DELETE FROM sessions WHERE user_id=$1", [result.rows[0].id]);
        await appendAudit(db, { id: null, name: "Operator CLI" }, "password_reset", result.rows[0].id, "Password reset by a database operator; sessions revoked and password change required.");
      });
      console.log("Temporary password set. Existing sessions were revoked.");
    } else if (command === "seed-demo") {
      if (config.environment === "production") throw new Error("Demo seeding is disabled in production.");
      const email = emailSchema.parse(process.env.ADMIN_EMAIL);
      const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE email=$1", [email]);
      if (!rows[0]) throw new Error("Create an administrator first and set ADMIN_EMAIL.");
      await seedDemo(pool, publicUser(rows[0]));
      console.log("Synthetic development examples loaded.");
    } else {
      throw new Error("Use migrate, provision-app, create-admin, reset-password, or seed-demo.");
    }
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Command failed.");
  process.exitCode = 1;
});
