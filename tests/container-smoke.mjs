import assert from "node:assert/strict";

const base = "http://127.0.0.1:3000";
const origin = "https://invoices.example.test";
const health = await fetch(`${base}/api/health/ready`);
assert.equal(health.status, 200);
const html = await fetch(`${base}/invoices/example`);
assert.equal(html.status, 200);
assert.match(html.headers.get("content-security-policy") ?? "", /object-src 'none'/);
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({ email: "ci@example.test", password: "Disposable-CI-passphrase-only" }),
});
assert.equal(login.status, 200, await login.clone().text());
const cookie = login.headers.get("set-cookie");
assert.match(cookie ?? "", /__Host-invoice_session/);
assert.match(cookie ?? "", /Secure/);
const session = await login.json();
assert.equal(session.user.role, "admin");
const headers = { Origin: origin, Cookie: cookie.split(";")[0], "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
const supplier = await fetch(`${base}/api/suppliers`, { method: "POST", headers, body: JSON.stringify({ name: "CI supplier", code: "CI", location: "Synthetic" }) });
assert.equal(supplier.status, 201, await supplier.clone().text());
const dashboard = await fetch(`${base}/api/dashboard`, { headers });
assert.equal(dashboard.status, 200);
assert.equal((await dashboard.json()).counts.exported, 0);
console.log("Container health, static assets, Secure sessions, and restricted-role mutations passed.");
