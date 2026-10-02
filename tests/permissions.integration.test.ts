import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import pino from "pino";
import type pg from "pg";
import { createPool, migrate, provisionAppRole, requireCurrentSchema } from "../server/database.js";
import { hashPassword, publicUser, type UserRow } from "../server/auth.js";
import { seedDemo } from "../server/seed.js";
import { createExport, reviewInvoice } from "../server/invoices.js";
import { createUser } from "../server/accounts.js";
import { invoiceDetail } from "../server/repository.js";
import type { User } from "../src/domain/types.js";

let owner: pg.Pool;
let runtime: pg.Pool;
let actor: User;
const role = `invoice_test_${randomBytes(8).toString("hex")}`;
const password = randomBytes(32).toString("hex");
const logger = pino({ level: "silent" });

beforeAll(async () => {
  owner = createPool(inject("databaseUrl"), logger);
  await migrate(owner);
  await owner.query("TRUNCATE invoice_history, audit_events, invoices, export_batches, delivery_records, purchase_orders, suppliers, sessions, rate_limits, users CASCADE");
  const { rows } = await owner.query<UserRow>("INSERT INTO users(id,email,name,password_hash,role,must_change_password) VALUES ('admin','admin@example.test','Admin',$1,'admin',false) RETURNING *", [await hashPassword("Permissions-test-password!")]);
  actor = publicUser(rows[0]);
  await seedDemo(owner, actor);
  await provisionAppRole(owner, password, role);
  const url = new URL(inject("databaseUrl"));
  url.username = role;
  url.password = password;
  runtime = createPool(url.toString(), logger);
});
afterAll(async () => {
  if (runtime) await runtime.end();
  if (owner) {
    await owner.query(`DROP OWNED BY "${role}"`);
    await owner.query(`DROP ROLE "${role}"`);
    await owner.end();
  }
});

describe("least-privilege production database role", () => {
  it("supports normal startup, administration, approval, and export workflows", async () => {
    await requireCurrentSchema(runtime);
    const user = await createUser(runtime, actor, { email: "created@example.test", name: "Created", role: "reviewer", password: "New-test-passphrase!" });
    expect(user.mustChangePassword).toBe(true);
    const invoice = await reviewInvoice(runtime, actor, "inv-001", { version: 1, action: "approved", note: "" });
    expect(invoice.status).toBe("ready_to_export");
    await createExport(runtime, actor, { requestId: crypto.randomUUID(), invoices: [{ id: invoice.id, version: invoice.version }] });
    expect((await invoiceDetail(runtime, invoice.id)).invoice.status).toBe("exported");
  });
  it("cannot delete finance records, rewrite audit trails, or change schemas", async () => {
    for (const query of ["DELETE FROM invoices", "UPDATE invoice_history SET detail='changed'", "DELETE FROM audit_events", "UPDATE export_batches SET csv='changed'", "ALTER TABLE users ADD COLUMN backdoor text", "TRUNCATE suppliers CASCADE"]) {
      await expect(runtime.query(query)).rejects.toThrow(/permission denied|must be owner/);
    }
  });
  it("validates role setup and safely reapplies grants", async () => {
    await expect(provisionAppRole(owner, "short", role)).rejects.toThrow("64-character");
    await expect(provisionAppRole(owner, password, "invalid-role")).rejects.toThrow("role name");
    await provisionAppRole(owner, password, role);
    await requireCurrentSchema(runtime);
  });
});
