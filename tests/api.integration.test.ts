import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import pino from "pino";
import type pg from "pg";
import { createApp } from "../server/app.js";
import { hashPassword, publicUser, tokenHash, type UserRow } from "../server/auth.js";
import { loadConfig } from "../server/config.js";
import { createPool, migrate, requireCurrentSchema } from "../server/database.js";
import { seedDemo } from "../server/seed.js";
import { workflow } from "../server/database.js";
import { emptyInvoiceInput, MAX_DOCUMENT_BYTES, type InvoiceInput } from "../src/domain/validation.js";
import type { DashboardData, ExportBatch, InvoiceDetail, InvoiceSummary, PageResult, Session } from "../src/domain/api.js";
import type { Invoice, ReviewHistory, User } from "../src/domain/types.js";
import { initialData } from "../src/data/demoData.js";

const password = "Test-only-password-123!";
const origin = "http://localhost:5173";
const logger = pino({ level: "silent" });
let pool: pg.Pool;
let server: Server;
let baseUrl: string;
let adminUser: User;
let passwordHash: string;

class Client {
  cookie = "";
  csrf = "";
  constructor(private url = baseUrl) {}
  request(path: string, method = "GET", body?: unknown, overrides: Record<string, string> = {}) {
    const headers: Record<string, string> = { Origin: origin, Cookie: this.cookie, "X-CSRF-Token": this.csrf, ...overrides };
    if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    return fetch(`${this.url}/api${path}`, { method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  }
  async login(email = "admin@example.test", suppliedPassword = password): Promise<Response> {
    const response = await this.request("/auth/login", "POST", { email, password: suppliedPassword });
    if (response.ok) {
      const session: Session = await response.clone().json();
      this.csrf = session.csrfToken;
      this.cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(this.cookie).not.toBe("");
    }
    return response;
  }
}
async function reviewer(): Promise<Client> {
  const client = new Client();
  expect((await client.login("reviewer@example.test")).status).toBe(200);
  return client;
}
async function administrator(): Promise<Client> {
  const client = new Client();
  expect((await client.login()).status).toBe(200);
  return client;
}
function matchedInput(number = "NEW-100"): InvoiceInput {
  const invoice = initialData.invoices[0];
  return {
    invoiceNumber: number, supplierId: invoice.supplierId, date: invoice.date, dueDate: invoice.dueDate,
    purchaseOrderId: invoice.purchaseOrderId, deliveryRecordId: invoice.deliveryRecordId ?? "",
    lineItems: invoice.lineItems.map(({ sku, description, quantity, unitPrice }) => ({ sku, description, quantity, unitPrice })), tax: invoice.tax,
  };
}
async function create(client: Client, invoice = matchedInput()): Promise<string> {
  const response = await client.request("/invoices", "POST", { requestId: randomUUID(), invoice });
  expect(response.status, await response.clone().text()).toBe(201);
  const body: { id: string } = await response.json();
  return body.id;
}
async function details(client: Client, id: string): Promise<InvoiceDetail> {
  const response = await client.request(`/invoices/${id}`);
  expect(response.status).toBe(200);
  return response.json();
}
function decision(client: Client, id: string, action: string, version = 1, note = "Verified against the source documents.") {
  return client.request(`/invoices/${id}/review`, "POST", { action, version, note });
}
function documentForm(bytes: Uint8Array, name = "invoice.png", type = "image/png", metadata: unknown = { requestId: randomUUID(), invoice: emptyInvoiceInput() }): FormData {
  const form = new FormData();
  form.append("data", JSON.stringify(metadata));
  form.append("document", new Blob([new Uint8Array(bytes)], { type }), name);
  return form;
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

beforeAll(async () => {
  pool = createPool(inject("databaseUrl"), logger);
  await migrate(pool);
  passwordHash = await hashPassword(password);
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: inject("databaseUrl"), APP_ORIGIN: origin });
  const app = await createApp({ pool, config, logger, serveStatic: false });
  server = await new Promise<Server>((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test HTTP address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await pool.query("TRUNCATE invoice_history, audit_events, invoices, export_batches, delivery_records, purchase_orders, suppliers, sessions, rate_limits, users CASCADE");
  const { rows } = await pool.query<UserRow>(`INSERT INTO users(id,email,name,password_hash,role,must_change_password) VALUES
    ('admin','admin@example.test','Test Admin',$1,'admin',false),
    ('reviewer','reviewer@example.test','Test Reviewer',$1,'reviewer',false) RETURNING *`, [passwordHash]);
  adminUser = publicUser(rows.find((row) => row.id === "admin")!);
  await seedDemo(pool, adminUser);
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (pool) await pool.end();
});

describe("authentication and access", () => {
  it("exposes health checks but no unauthenticated invoice data", async () => {
    const client = new Client();
    expect((await client.request("/health/live")).status).toBe(200);
    expect((await client.request("/health/ready")).status).toBe(200);
    for (const path of ["/dashboard", "/invoices", "/invoices/inv-001/document", "/exports", "/admin/users", "/suppliers"]) {
      expect((await client.request(path)).status).toBe(401);
    }
  });
  it("uses opaque HttpOnly sessions, shared state, and explicit logout", async () => {
    const client = await administrator();
    const response = await client.login();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const session: Session = await (await client.request("/auth/me")).json();
    expect(session.user).toMatchObject({ name: "Test Admin", role: "admin" });
    expect(session.user).not.toHaveProperty("password_hash");
    const stored = await pool.query<{ token_hash: string }>("SELECT token_hash FROM sessions");
    expect(stored.rows.every((row) => !client.cookie.includes(row.token_hash))).toBe(true);
    expect((await client.request("/auth/logout", "POST")).status).toBe(200);
    expect((await client.request("/auth/me")).status).toBe(401);
  });
  it("does not reveal whether an account exists or is disabled", async () => {
    const client = new Client();
    await pool.query("UPDATE users SET active=false WHERE id='reviewer'");
    for (const email of ["missing@example.test", "reviewer@example.test"]) {
      const response = await client.login(email);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." } });
    }
    expect((await client.login("admin@example.test", "incorrect")).status).toBe(401);
  });
  it.each(["", "wrong", "é".repeat(64)])("rejects missing or invalid CSRF headers (%s)", async (csrf) => {
    const client = await reviewer();
    const response = await client.request("/invoices/inv-001/review", "POST", { action: "approved", version: 1, note: "" }, { "X-CSRF-Token": csrf });
    expect(response.status).toBe(403);
  });
  it("rejects cross-origin mutations, including login", async () => {
    const response = await new Client().request("/auth/login", "POST", { email: "admin@example.test", password }, { Origin: "https://attacker.example" });
    expect(response.status).toBe(403);
  });
  it("enforces expiry and current active-account state", async () => {
    const client = await reviewer();
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute'");
    expect((await client.request("/invoices")).status).toBe(401);
    await client.login("reviewer@example.test");
    await pool.query("UPDATE users SET active=false WHERE id='reviewer'");
    expect((await client.request("/invoices")).status).toBe(401);
  });
  it("rate limits login attempts using shared database counters", async () => {
    await pool.query("INSERT INTO rate_limits(key,attempts,reset_at) VALUES ($1,10,now()+interval '15 minutes')", [tokenHash("login-account:admin@example.test")]);
    const response = await new Client().login();
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("prevents reviewers from administering accounts or reference data", async () => {
    const client = await reviewer();
    expect((await client.request("/admin/users")).status).toBe(403);
    expect((await client.request("/admin/audit")).status).toBe(403);
    for (const path of ["/admin/users", "/suppliers", "/purchase-orders", "/deliveries"]) expect((await client.request(path, "POST", {})).status).toBe(403);
    expect((await decision(client, "inv-007", "reopened")).status).toBe(403);
  });
  it("creates temporary-password accounts and requires password rotation", async () => {
    const admin = await administrator();
    const created = await admin.request("/admin/users", "POST", { email: "new@example.test", name: "New Reviewer", role: "reviewer", password });
    expect(created.status).toBe(201);
    const user: User = await created.json();
    expect(user.mustChangePassword).toBe(true);
    expect(user).not.toHaveProperty("password");
    const newcomer = new Client();
    expect((await newcomer.login(user.email)).status).toBe(200);
    expect((await newcomer.request("/invoices")).status).toBe(403);
    const oldCookie = newcomer.cookie;
    const changed = await newcomer.request("/auth/change-password", "POST", { currentPassword: password, newPassword: "New-test-password-456!" });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("set-cookie")).not.toContain(oldCookie);
    expect((await newcomer.request("/auth/me")).status).toBe(401);
    expect((await newcomer.login(user.email, "New-test-password-456!")).status).toBe(200);
    expect((await newcomer.request("/invoices")).status).toBe(200);
  });
  it("rejects wrong current passwords, weak passwords, and password reuse", async () => {
    const client = await reviewer();
    for (const input of [
      { currentPassword: "wrong", newPassword: "A-new-password-456!" },
      { currentPassword: password, newPassword: "short" },
      { currentPassword: password, newPassword: password },
    ]) expect((await client.request("/auth/change-password", "POST", input)).status).toBe(400);
    expect((await client.request("/auth/me")).status).toBe(200);
  });
  it("revokes sessions on account changes and password reset", async () => {
    const admin = await administrator();
    const user = await reviewer();
    expect((await admin.request("/admin/users/reviewer", "PATCH", { active: false, role: "reviewer" })).status).toBe(200);
    expect((await user.request("/invoices")).status).toBe(401);
    expect((await admin.request("/admin/users/reviewer", "PATCH", { active: true, role: "reviewer" })).status).toBe(200);
    await user.login("reviewer@example.test");
    expect((await admin.request("/admin/users/reviewer/reset-password", "POST", { password: "Temporary-test-password!" })).status).toBe(200);
    expect((await user.request("/invoices")).status).toBe(401);
    expect((await user.login("reviewer@example.test", "Temporary-test-password!")).status).toBe(200);
    expect((await user.request("/invoices")).status).toBe(403);
  });
  it("prevents self-disable and returns a conflict for duplicate accounts", async () => {
    const client = await administrator();
    expect((await client.request("/admin/users/admin", "PATCH", { active: false, role: "reviewer" })).status).toBe(409);
    expect((await client.request("/admin/users/admin/reset-password", "POST", { password })).status).toBe(409);
    expect((await client.request("/admin/users", "POST", { email: "admin@example.test", name: "Duplicate", role: "admin", password })).status).toBe(409);
  });
  it("rejects removed accounts and invalid session cookies", async () => {
    const admin = await administrator();
    expect((await admin.request("/admin/users/missing", "PATCH", { active: false, role: "reviewer" })).status).toBe(404);
    expect((await admin.request("/admin/users/missing/reset-password", "POST", { password })).status).toBe(404);
    const invalid = new Client();
    invalid.cookie = "invoice_session=not-a-valid-token";
    expect((await invalid.request("/auth/me")).status).toBe(401);
    await pool.query("UPDATE users SET active=false WHERE id='reviewer'");
    await expect(workflow(pool, { ...adminUser, id: "reviewer", role: "reviewer" }, async () => "should not run")).rejects.toThrow("no longer active");
    await pool.query("UPDATE users SET must_change_password=true WHERE id='admin'");
    await expect(workflow(pool, adminUser, async () => "should not run")).rejects.toThrow("temporary password");
  });
  it("emits production cookie, HSTS, and proxy settings without allowing HTTP origins", async () => {
    const config = loadConfig({ NODE_ENV: "production", DATABASE_URL: inject("databaseUrl"), APP_ORIGIN: "https://invoices.example.test", TRUST_PROXY: "1" });
    const app = await createApp({ pool, config, logger, serveStatic: false });
    const secureServer = await new Promise<Server>((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    try {
      const address = secureServer.address();
      if (!address || typeof address === "string") throw new Error("No secure test address.");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
        method: "POST", headers: { Origin: config.origin, "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
        body: JSON.stringify({ email: "admin@example.test", password }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("__Host-invoice_session");
      expect(response.headers.get("set-cookie")).toContain("Secure");
      expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    } finally {
      await new Promise<void>((resolve, reject) => secureServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("invoice workflow and matching", () => {
  it("paginates, searches, filters, and sorts on the server", async () => {
    const client = await reviewer();
    const page: PageResult<InvoiceSummary> = await (await client.request("/invoices?page=2&limit=2&sort=date_desc")).json();
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(7);
    expect(page.items[0].date >= page.items[1].date).toBe(true);
    const filtered: PageResult<InvoiceSummary> = await (await client.request("/invoices?search=Northstar&status=matched&sort=amount_desc")).json();
    expect(filtered.items.map((invoice) => invoice.id)).toEqual(["inv-001"]);
    const literal: PageResult<InvoiceSummary> = await (await client.request("/invoices?search=%25")).json();
    expect(literal.total).toBe(0);
    expect((await client.request("/invoices?limit=1001")).status).toBe(400);
    expect((await client.request("/invoices?sort=DROP%20TABLE%20users")).status).toBe(400);
  });
  it("derives dashboard counts from persisted state", async () => {
    const client = await reviewer();
    const before: DashboardData = await (await client.request("/dashboard")).json();
    expect(before.counts.ready_to_export).toBe(1);
    expect((await decision(client, "inv-001", "approved")).status).toBe(200);
    const after: DashboardData = await (await client.request("/dashboard")).json();
    expect(after.counts.ready_to_export).toBe(2);
    expect(after.history[0].user).toBe("Test Reviewer");
  });
  it("supports incomplete drafts but never approves one", async () => {
    const client = await reviewer();
    const id = await create(client, emptyInvoiceInput());
    const draft = await details(client, id);
    expect(draft.invoice.status).toBe("needs_review");
    expect(draft.exceptions.length).toBeGreaterThan(5);
    expect((await decision(client, id, "approved")).status).toBe(422);
  });
  it.each(["inv-002", "inv-003", "inv-004", "inv-005", "inv-006"])("blocks every existing exception on %s", async (id) => {
    const client = await reviewer();
    expect((await decision(client, id, "approved")).status).toBe(422);
    expect((await details(client, id)).history.items).toHaveLength(1);
  });
  it("edits and verifies draft fields before approval, preserving audit snapshots", async () => {
    const client = await reviewer();
    const invoice = initialData.invoices[1];
    const input: InvoiceInput = {
      invoiceNumber: invoice.invoiceNumber, supplierId: invoice.supplierId, date: invoice.date, dueDate: invoice.dueDate,
      purchaseOrderId: invoice.purchaseOrderId, deliveryRecordId: invoice.deliveryRecordId ?? "",
      lineItems: [{ sku: "FLT-A20", description: "Air intake filter", quantity: 10, unitPrice: 12 }], tax: 0,
    };
    const updated = await client.request("/invoices/inv-002", "PUT", { invoice: input, version: 1, note: "Corrected price to match the source." });
    expect(updated.status).toBe(200);
    expect((await details(client, "inv-002")).exceptions).toHaveLength(0);
    expect((await decision(client, "inv-002", "approved", 2)).status).toBe(200);
    const reviewed = await details(client, "inv-002");
    expect(reviewed.invoice.version).toBe(3);
    expect(reviewed.history.items.map((event) => event.action)).toEqual(["approved", "updated", "created"]);
    expect(reviewed.history.items[2].snapshot?.lineItems[0].unitPrice).toBe(13.5);
    expect(reviewed.history.items[0].snapshot?.lineItems[0].unitPrice).toBe(12);
  });
  it("rejects stale versions without adding history", async () => {
    const client = await reviewer();
    expect((await decision(client, "inv-001", "escalated")).status).toBe(200);
    expect((await decision(client, "inv-001", "approved")).status).toBe(409);
    expect((await client.request("/invoices/inv-001", "PUT", { invoice: matchedInput(), version: 1, note: "Outdated edit." })).status).toBe(409);
    expect((await details(client, "inv-001")).history.items).toHaveLength(2);
  });
  it("requires reasons and records real reviewers for correction and escalation", async () => {
    const client = await reviewer();
    expect((await decision(client, "inv-002", "correction_requested", 1, "")).status).toBe(400);
    expect((await decision(client, "inv-002", "correction_requested")).status).toBe(200);
    expect((await decision(client, "inv-002", "escalated", 2)).status).toBe(200);
    const detail = await details(client, "inv-002");
    expect(detail.invoice.status).toBe("escalated");
    expect(detail.history.items[0].user).toBe("Test Reviewer");
  });
  it("resolves duplicates by voiding the incorrect record, not hiding its audit trail", async () => {
    const client = await reviewer();
    expect((await decision(client, "inv-005", "voided")).status).toBe(200);
    expect((await decision(client, "inv-004", "approved")).status).toBe(200);
    expect((await decision(client, "inv-005", "approved", 2)).status).toBe(409);
    expect((await details(client, "inv-005")).history.items[0].action).toBe("voided");
  });
  it("indexes Unicode-normalized duplicate keys independently of PostgreSQL collation", async () => {
    const client = await reviewer();
    const first = await create(client, matchedInput("\u0130-REPEAT"));
    const duplicate = await create(client, matchedInput("i\u0307-repeat"));
    expect((await details(client, duplicate)).exceptions.some((exception) => exception.type === "duplicate")).toBe(true);
    expect((await details(client, first)).exceptions.some((exception) => exception.type === "duplicate")).toBe(true);
    expect((await decision(client, first, "approved")).status).toBe(422);
  });
  it("allows only explicit admin reopen for approved invoices", async () => {
    const client = await administrator();
    expect((await decision(client, "inv-007", "approved")).status).toBe(409);
    expect((await decision(client, "inv-007", "reopened")).status).toBe(200);
    expect((await details(client, "inv-007")).invoice.status).toBe("needs_review");
    expect((await decision(client, "inv-007", "reopened", 2)).status).toBe(409);
  });
  it("rejects forged status, actor, invalid totals, and cross-supplier references", async () => {
    const client = await reviewer();
    for (const invoice of [
      { ...matchedInput(), status: "ready_to_export" },
      { ...matchedInput(), tax: -1 },
      { ...matchedInput(), dueDate: "2026-01-01" },
    ]) expect((await client.request("/invoices", "POST", { requestId: randomUUID(), invoice })).status).toBe(400);
    expect((await client.request("/invoices", "POST", { requestId: randomUUID(), invoice: { ...matchedInput(), supplierId: "sup-002" } })).status).toBe(422);
    expect((await client.request("/invoices", "POST", { requestId: randomUUID(), invoice: { ...matchedInput(), deliveryRecordId: "del-002" } })).status).toBe(422);
    expect((await client.request("/invoices/inv-001/review", "POST", { action: "approved", version: 1, note: "", user: "Forged" })).status).toBe(400);
  });
  it("makes draft creation safely retryable without duplicating records", async () => {
    const client = await reviewer();
    const request = { requestId: randomUUID(), invoice: matchedInput() };
    expect((await client.request("/invoices", "POST", request)).status).toBe(201);
    expect((await client.request("/invoices", "POST", request)).status).toBe(201);
    const count = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM invoices WHERE id=$1", [request.requestId]);
    expect(count.rows[0].count).toBe(1);
    expect((await client.request("/invoices", "POST", { ...request, invoice: matchedInput("different") })).status).toBe(409);
  });
  it("rejects a cross-account idempotency replay and preserves incomplete fields", async () => {
    const client = await reviewer();
    const request = { requestId: randomUUID(), invoice: emptyInvoiceInput() };
    expect((await client.request("/invoices", "POST", request)).status).toBe(201);
    expect((await (await administrator()).request("/invoices", "POST", request)).status).toBe(409);
    const draft = await details(client, request.requestId);
    expect(draft.supplier).toBeUndefined();
    expect(draft.purchaseOrder).toBeUndefined();
    expect(draft.invoice.date).toBe("");
    expect((await client.request(`/invoices/${request.requestId}`, "PUT", { version: 1, invoice: request.invoice, note: "Still incomplete" })).status).toBe(200);
    expect((await decision(client, request.requestId, "approved", 2)).status).toBe(422);
  });
  it("serializes concurrent approvals to prevent cumulative overbilling", async () => {
    const client = await reviewer();
    const other = await administrator();
    const first = await create(client, matchedInput("PART-A"));
    const second = await create(other, matchedInput("PART-B"));
    const results = await Promise.all([decision(client, first, "approved"), decision(other, second, "approved")]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 422]);
  });
  it("returns paginated, immutable history and missing-record errors", async () => {
    const client = await reviewer();
    await decision(client, "inv-001", "escalated");
    const history: PageResult<ReviewHistory> = await (await client.request("/invoices/inv-001/history?limit=1&page=2")).json();
    expect(history.total).toBe(2);
    expect(history.items[0].action).toBe("created");
    await expect(pool.query("UPDATE invoice_history SET detail='changed'")).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM audit_events")).rejects.toThrow("immutable");
    expect((await client.request("/invoices/missing")).status).toBe(404);
    expect((await decision(client, "missing", "approved")).status).toBe(404);
  });
});

describe("documents, exports, and reference data", () => {
  it("persists uploaded documents and serves authenticated attachment downloads", async () => {
    const client = await reviewer();
    const response = await client.request("/invoices", "POST", documentForm(png));
    expect(response.status, await response.clone().text()).toBe(201);
    const { id }: { id: string } = await response.json();
    const detail = await details(client, id);
    expect(detail.invoice.sourceFile).toMatchObject({ name: "invoice.png", type: "image/png", size: png.length });
    expect(detail.invoice.sourceFile).not.toHaveProperty("previewUrl");
    const download = await client.request(`/invoices/${id}/document`);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(png);
    expect((await new Client().request(`/invoices/${id}/document`)).status).toBe(401);
  });
  it("rejects empty, mislabeled, oversized, and malformed uploads", async () => {
    const client = await reviewer();
    expect((await client.request("/invoices", "POST", documentForm(new Uint8Array()))).status).toBe(400);
    expect((await client.request("/invoices", "POST", documentForm(png, "fake.pdf", "application/pdf"))).status).toBe(400);
    expect((await client.request("/invoices", "POST", documentForm(png, "unsafe.html", "image/png"))).status).toBe(400);
    const oversized = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    oversized.set(png);
    expect((await client.request("/invoices", "POST", documentForm(oversized))).status).toBe(413);
    const malformed = new FormData();
    malformed.append("data", "{broken");
    expect((await client.request("/invoices", "POST", malformed)).status).toBe(400);
    expect((await client.request("/invoices/inv-001/document")).status).toBe(404);
  });
  it("creates exactly-once, recoverable CSV export batches and locks invoices", async () => {
    const client = await reviewer();
    const input = { requestId: randomUUID(), invoices: [{ id: "inv-007", version: 1 }] };
    const [first, replay] = await Promise.all([client.request("/exports", "POST", input), client.request("/exports", "POST", input)]);
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(await first.json()).toEqual(await replay.json());
    const exported = await details(client, "inv-007");
    expect(exported.invoice.status).toBe("exported");
    expect(exported.history.items).toHaveLength(2);
    const batches: PageResult<ExportBatch> = await (await client.request("/exports")).json();
    expect(batches.total).toBe(1);
    const download = await client.request(`/exports/${input.requestId}/download`);
    expect(await download.text()).toContain("NFM-24096");
    expect((await client.request("/exports", "POST", { ...input, requestId: randomUUID() })).status).toBe(409);
    expect((await decision(await administrator(), "inv-007", "reopened", 2)).status).toBe(409);
    await expect(pool.query("UPDATE export_batches SET csv='changed'")).rejects.toThrow("immutable");
  });
  it("rejects unapproved, stale, duplicate, and changed export requests", async () => {
    const client = await reviewer();
    expect((await client.request("/exports", "POST", { requestId: randomUUID(), invoices: [{ id: "inv-001", version: 1 }] })).status).toBe(409);
    expect((await client.request("/exports", "POST", { requestId: randomUUID(), invoices: [{ id: "inv-007", version: 999 }] })).status).toBe(409);
    expect((await client.request("/exports", "POST", { requestId: randomUUID(), invoices: [{ id: "inv-007", version: 1 }, { id: "inv-007", version: 1 }] })).status).toBe(400);
    const input = { requestId: randomUUID(), invoices: [{ id: "inv-007", version: 1 }] };
    expect((await client.request("/exports", "POST", input)).status).toBe(201);
    expect((await client.request("/exports", "POST", { ...input, invoices: [{ id: "inv-001", version: 1 }] })).status).toBe(409);
    expect((await client.request("/exports/missing/download")).status).toBe(404);
  });
  it("rechecks approvals at export time when a new duplicate arrives", async () => {
    const client = await reviewer();
    expect((await decision(client, "inv-001", "approved")).status).toBe(200);
    await create(client, matchedInput("nfm-24081"));
    const response = await client.request("/exports", "POST", { requestId: randomUUID(), invoices: [{ id: "inv-001", version: 2 }] });
    expect(response.status).toBe(422);
    expect((await details(client, "inv-001")).invoice.status).toBe("ready_to_export");
  });
  it("supports creating suppliers, POs and receipts without demo data", async () => {
    const client = await administrator();
    const supplierResponse = await client.request("/suppliers", "POST", { name: "New Supplier", code: "NEW", location: "London" });
    expect(supplierResponse.status).toBe(201);
    const supplier: { id: string } = await supplierResponse.json();
    const orderResponse = await client.request("/purchase-orders", "POST", { poNumber: "NEW-PO", supplierId: supplier.id, orderedDate: "2026-09-01", lineItems: [{ sku: "ITEM", description: "New item", quantity: 10, unitPrice: 12.34 }] });
    expect(orderResponse.status).toBe(201);
    const order: { id: string } = await orderResponse.json();
    const receipt = { deliveryNumber: "NEW-GRN", purchaseOrderId: order.id, receivedDate: "2026-09-02", lineItems: [{ sku: "ITEM", description: "New item", quantity: 6 }] };
    expect((await client.request("/deliveries", "POST", receipt)).status).toBe(201);
    expect((await client.request("/deliveries", "POST", { ...receipt, deliveryNumber: "TOO-MANY" })).status).toBe(422);
    expect((await client.request("/deliveries", "POST", { ...receipt, deliveryNumber: "TOO-EARLY", receivedDate: "2026-08-31" })).status).toBe(422);
    expect((await client.request("/suppliers", "POST", { name: "Duplicate", code: "new", location: "" })).status).toBe(409);
    const orders: PageResult<{ id: string }> = await (await client.request(`/purchase-orders?supplierId=${supplier.id}`)).json();
    expect(orders.items[0].id).toBe(order.id);
    await expect(pool.query("UPDATE purchase_orders SET po_number='changed'")).rejects.toThrow("immutable");
  });
  it("rejects missing references and unsupported reference filters", async () => {
    const client = await administrator();
    expect((await client.request("/suppliers/missing")).status).toBe(422);
    expect((await client.request("/suppliers?supplierId=sup-001")).status).toBe(400);
    expect((await client.request("/purchase-orders?purchaseOrderId=po-001")).status).toBe(400);
    const receipts = await client.request("/deliveries?purchaseOrderId=po-001");
    expect(receipts.status).toBe(200);
    expect((await receipts.json()).total).toBe(1);
    expect((await client.request("/admin/users?page=2&limit=1")).status).toBe(200);
    expect((await client.request("/admin/audit?limit=1")).status).toBe(200);
  });
  it("handles malformed JSON, request limits, and unknown multipart fields", async () => {
    const client = await reviewer();
    const malformed = await fetch(`${baseUrl}/api/invoices`, { method: "POST", headers: { Origin: origin, Cookie: client.cookie, "X-CSRF-Token": client.csrf, "Content-Type": "application/json" }, body: "{invalid" });
    expect(malformed.status).toBe(400);
    expect((await client.request("/invoices", "POST", { value: "x".repeat(129 * 1024) })).status).toBe(413);
    const extra = documentForm(png);
    extra.append("unexpected", "value");
    expect((await client.request("/invoices", "POST", extra)).status).toBe(400);
    expect((await client.request("/invoices", "POST", new FormData())).status).toBe(400);
  });
  it("masks unexpected database errors and detects unapplied migrations", async () => {
    const client = await reviewer();
    await pool.query("ALTER TABLE invoices RENAME TO unavailable_invoices");
    try {
      const response = await client.request("/invoices");
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(body)).not.toContain("unavailable_invoices");
    } finally { await pool.query("ALTER TABLE unavailable_invoices RENAME TO invoices"); }
    await pool.query("UPDATE schema_migrations SET checksum='modified'");
    try {
      await expect(migrate(pool)).rejects.toThrow("modified");
      await expect(requireCurrentSchema(pool)).rejects.toThrow("missing or modified");
    } finally {
      await pool.query("DELETE FROM schema_migrations");
      const { createHash } = await import("node:crypto");
      const { readFile } = await import("node:fs/promises");
      const sql = await readFile(new URL("../server/migrations/001_initial.sql", import.meta.url), "utf8");
      await pool.query("INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)", ["001_initial.sql", createHash("sha256").update(sql).digest("hex")]);
    }
  });
  it("returns bounded errors and security headers without internal exception details", async () => {
    const client = await reviewer();
    const response = await client.request("/invoices?limit=invalid");
    expect(response.status).toBe(400);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const body = await response.json();
    expect(body).toHaveProperty("requestId");
    expect(body).not.toHaveProperty("stack");
    expect((await client.request("/not-an-endpoint")).status).toBe(404);
  });
  it("keeps sessions and invoices across independent API instances", async () => {
    const client = await reviewer();
    const id = await create(client, emptyInvoiceInput());
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: inject("databaseUrl"), APP_ORIGIN: origin });
    const app = await createApp({ pool, config, logger, serveStatic: false });
    const second = await new Promise<Server>((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    try {
      const address = second.address();
      if (!address || typeof address === "string") throw new Error("No second server address.");
      const other = new Client(`http://127.0.0.1:${address.port}`);
      other.cookie = client.cookie;
      other.csrf = client.csrf;
      expect((await details(other, id)).invoice.id).toBe(id);
    } finally {
      await new Promise<void>((resolve, reject) => second.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("applies migrations idempotently and rejects reseeding non-empty data", async () => {
    await migrate(pool);
    await requireCurrentSchema(pool);
    await expect(seedDemo(pool, adminUser)).rejects.toThrow("empty");
    const client = await reviewer();
    const invoice: Invoice = (await details(client, "inv-001")).invoice;
    expect(invoice.invoiceNumber).toBe("NFM-24081");
  });
});
