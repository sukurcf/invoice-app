import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email = "admin@example.test", password = "E2e-only-passphrase-123!") {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("admin configures real references, uploads, edits, approves, exports and reloads", async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Welcome, Alex" })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Reference data" }).click();
  await page.getByLabel("Supplier name").fill(`E2E Supplier ${suffix}`);
  await page.getByLabel("Supplier code").fill(`SUP-${suffix}`);
  await page.getByLabel("Location").fill("Test location");
  await page.getByRole("button", { name: "Create reference record" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Reference record saved" })).toBeVisible();
  await page.getByRole("button", { name: "Purchase orders", exact: true }).click();
  await page.getByLabel("PO number").fill(`PO-${suffix}`);
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: `E2E Supplier ${suffix} (SUP-${suffix})` });
  await page.getByLabel("Order date").fill("2026-09-01");
  await page.getByRole("button", { name: "Add line item" }).click();
  await page.getByLabel("Line 1 SKU").fill("ITEM-1");
  await page.getByLabel("Line 1 description").fill("Verified test item");
  await page.getByLabel("Line 1 quantity").fill("5");
  await page.getByLabel("Line 1 unit price").fill("20");
  await page.getByRole("button", { name: "Create reference record" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Reference record saved" })).toBeVisible();
  await page.getByRole("button", { name: "Goods receipts", exact: true }).click();
  await page.getByLabel("Receipt number").fill(`GRN-${suffix}`);
  await page.getByLabel("Purchase order", { exact: true }).selectOption({ label: `PO-${suffix}` });
  await page.getByLabel("Receipt date").fill("2026-09-02");
  await page.getByRole("button", { name: "Add line item" }).click();
  await page.getByLabel("Line 1 SKU").fill("ITEM-1");
  await page.getByLabel("Line 1 description").fill("Verified test item");
  await page.getByLabel("Line 1 quantity").fill("5");
  await page.getByRole("button", { name: "Create reference record" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Reference record saved" })).toBeVisible();

  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "New invoice" }).click();
  await page.getByLabel("Invoice number", { exact: true }).fill(`INV-${suffix}`);
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: `E2E Supplier ${suffix} (SUP-${suffix})` });
  await page.getByLabel("Purchase order", { exact: true }).selectOption({ label: `PO-${suffix}` });
  await page.getByLabel("Delivery record", { exact: true }).selectOption({ label: `GRN-${suffix}` });
  await page.getByLabel("Invoice date", { exact: true }).fill("2026-09-03");
  await page.getByLabel("Due date").fill("2026-10-03");
  await page.getByRole("button", { name: /Use PO line items/ }).click();
  await page.getByLabel("Line 1 unit price").fill("22");
  await page.getByLabel("Invoice document").setInputFiles({
    name: "invoice.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  });
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { name: `INV-${suffix}`, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve for export" })).toBeDisabled();
  await page.getByRole("button", { name: "Edit invoice" }).click();
  await page.getByLabel("Line 1 unit price").fill("20");
  await page.getByLabel("Reason for changes").fill("Corrected the unit price after verifying the source document.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Approve for export" })).toBeEnabled();
  await page.getByRole("button", { name: "Approve for export" }).click();
  await expect(page.getByText("Ready to export", { exact: true })).toBeVisible();
  const reviewUrl = page.url();
  await page.reload();
  await expect(page.getByRole("heading", { name: `INV-${suffix}`, level: 1 })).toBeVisible();
  const sourceDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download source document" }).click();
  expect((await sourceDownload).suggestedFilename()).toBe("invoice.png");

  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Exports" }).click();
  await page.getByLabel(`Select invoice INV-${suffix}`).check();
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Create CSV export (1)" }).click();
  expect((await csvDownload).suggestedFilename()).toMatch(/^invoices-.+\.csv$/);
  await expect(page.getByRole("status")).toContainText("Export batch saved");
  await page.reload();
  await expect(page.getByRole("button", { name: "Download CSV" }).first()).toBeVisible();
  await page.goto(reviewUrl);
  await expect(page.getByText("Exported", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit invoice" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("admin provisions a reviewer and temporary password flow works end to end", async ({ page, browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `reviewer-${suffix}@example.test`;
  await signIn(page);
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Team access" }).click();
  await page.getByLabel("Full name").fill("New Team Member");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Temporary password", { exact: true }).fill("Temporary-E2e-passphrase!");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Account created");
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    await signIn(member, email, "Temporary-E2e-passphrase!");
    await expect(member.getByRole("heading", { name: "Change your temporary password" })).toBeVisible();
    await member.getByLabel("Current password").fill("Temporary-E2e-passphrase!");
    await member.getByLabel("New password", { exact: true }).fill("My-own-E2e-passphrase!");
    await member.getByLabel("Confirm new password").fill("My-own-E2e-passphrase!");
    await member.getByRole("button", { name: "Change password", exact: true }).click();
    await expect(member.getByRole("heading", { name: "Welcome, New" })).toBeVisible();
    await member.goto("/users");
    await expect(member.getByRole("heading", { name: "Administrator access required" })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: email });
    await row.getByRole("button", { name: "Disable account" }).click();
    await member.getByRole("button", { name: "Refresh", exact: true }).click();
    await member.goto("/invoices");
    await expect(member.getByRole("heading", { name: "Sign in to your workspace" })).toBeVisible();
  } finally { await context.close(); }
});

test("reviewer mobile navigation, deep links, exception safeguards, and no page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "reviewer@example.test");
  await expect(page.getByRole("heading", { name: "Welcome, Taylor" })).toBeVisible();
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Invoice queue" }).click();
  await page.getByRole("textbox", { name: "Search invoices" }).fill("ALP-8837");
  await page.getByRole("button", { name: "ALP-8837", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ALP-8837", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve for export" })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("heading", { name: "ALP-8837", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to your workspace" })).toBeVisible();
});

test("API errors remain JSON and static deep links retain restrictive headers", async ({ request }) => {
  const page = await request.get("/invoices/inv-001");
  expect(page.status()).toBe(200);
  expect(page.headers()["content-security-policy"]).toContain("object-src 'none'");
  expect(page.headers()["cache-control"]).toBe("no-cache");
  const api = await request.get("/api/invoices");
  expect(api.status()).toBe(401);
  expect(api.headers()["content-type"]).toContain("application/json");
  expect(api.headers()["cache-control"]).toBe("no-store");
  expect((await request.get("/missing-script.js")).status()).toBe(404);
});
