import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialData } from "../data/demoData";
import { apiError, detailFor, json, mockApi, renderApp, summaryFor } from "../test/helpers";
import type { Invoice, ReviewHistory } from "../domain/types";
import { invoiceInputSchema } from "../domain/validation";

beforeEach(() => {
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn().mockReturnValue("blob:preview"), revokeObjectURL: vi.fn() }));
});
afterEach(() => vi.unstubAllGlobals());

describe("dashboard and invoice queue", () => {
  it("derives counts, opens priority invoices and navigates to exports", async () => {
    mockApi();
    renderApp();
    expect(await screen.findByRole("heading", { name: "Welcome, Alex" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Invoice summary" })).toHaveTextContent("Ready for export");
    await userEvent.click(screen.getByRole("button", { name: /ALP-8837/ }));
    expect(await screen.findByRole("heading", { name: "ALP-8837", level: 1 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Back to invoice queue/ }));
    expect(await screen.findByRole("heading", { name: "Invoice queue" })).toBeInTheDocument();
  });
  it("provides empty-workspace onboarding and refreshes failed dashboard requests", async () => {
    let fail = true;
    mockApi({ data: { ...initialData, invoices: [], reviewHistory: [] }, handle: (call) => call.path === "/dashboard" && fail ? apiError("Temporary outage") : undefined });
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary outage");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Set up your workspace" })).toBeInTheDocument();
    expect(screen.getByText("No review activity yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add reference data" }));
    expect(await screen.findByRole("heading", { name: "Reference data", level: 1 })).toBeInTheDocument();
  });
  it("searches, filters, sorts, and shows an explicit empty result", async () => {
    const api = mockApi();
    renderApp("/invoices");
    await screen.findByRole("button", { name: "NFM-24081" });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Search invoices" }), "Northstar");
    await waitFor(() => expect(screen.queryByRole("button", { name: "ALP-8837" })).not.toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Filter by status"), "matched");
    await user.selectOptions(screen.getByLabelText("Sort invoices"), "amount_desc");
    await waitFor(() => expect(api.calls.some((call) => call.query.get("sort") === "amount_desc" && call.query.get("status") === "matched")).toBe(true));
    await user.clear(screen.getByRole("textbox", { name: "Search invoices" }));
    await user.type(screen.getByRole("textbox", { name: "Search invoices" }), "not-present");
    expect(await screen.findByText("No invoices found")).toBeInTheDocument();
  });
  it("paginates large queues and displays request failures", async () => {
    mockApi({ handle: (call) => {
      if (call.path === "/invoices" && call.query.get("page") === "2") return apiError("Could not load page two");
      if (call.path === "/invoices") return json({ items: [summaryFor(initialData.invoices[0])], total: 26, page: 1, limit: 25 });
    } });
    renderApp("/invoices");
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load page two");
  });
});

describe("invoice review experience", () => {
  it("disables approval for exceptions, requires notes, and records an escalation", async () => {
    const api = mockApi({ handle: (call) => call.path.endsWith("/review") ? json({ ok: true }) : undefined });
    renderApp("/invoices/inv-002");
    expect(await screen.findByRole("button", { name: "Approve for export" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Escalate" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Review note"), "Investigate the price variance.");
    await userEvent.click(screen.getByRole("button", { name: "Escalate" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Escalate saved");
    expect(api.calls.find((call) => call.path.endsWith("/review"))?.body).toEqual({ action: "escalated", version: 1, note: "Investigate the price variance." });
  });
  it("approves clear invoices and displays version conflicts rather than local success", async () => {
    let fail = true;
    mockApi({ handle: (call) => call.path.endsWith("/review") ? fail ? apiError("Another user changed this invoice.", 409, "VERSION_CONFLICT") : json({ ok: true }) : undefined });
    renderApp("/invoices/inv-001");
    await userEvent.click(await screen.findByRole("button", { name: "Approve for export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another user changed");
    expect(screen.queryByText(/Approve for export saved/)).not.toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Approve for export" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Approve for export saved");
  });
  it("edits and verifies line prices with an auditable reason", async () => {
    const data = structuredClone(initialData);
    const api = mockApi({ data, handle: (call) => {
      if (call.method !== "PUT") return;
      if (typeof call.body !== "object" || call.body === null || !("invoice" in call.body)) throw new Error("Missing invoice body.");
      const input = invoiceInputSchema.parse(call.body.invoice);
      const index = data.invoices.findIndex((invoice) => invoice.id === "inv-002");
      data.invoices[index] = { ...data.invoices[index], ...input, version: 2, lineItems: input.lineItems.map((line) => ({ ...line, id: "line-1" })), extractedFields: [] };
      return json(data.invoices[index]);
    } });
    renderApp("/invoices/inv-002");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit invoice" }));
    await user.clear(screen.getByLabelText("Line 1 unit price"));
    await user.type(screen.getByLabelText("Line 1 unit price"), "12");
    await user.type(screen.getByLabelText("Reason for changes"), "Corrected to source price.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Invoice fields and verification history saved.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve for export" })).toBeEnabled());
    expect(api.calls.find((call) => call.method === "PUT")?.body).toMatchObject({ version: 1, note: "Corrected to source price." });
  });
  it("keeps edits on save failure and supports explicit discard and reload", async () => {
    mockApi({ handle: (call) => call.method === "PUT" ? apiError("Version conflict", 409) : undefined });
    renderApp("/invoices/inv-001");
    await userEvent.click(await screen.findByRole("button", { name: "Edit invoice" }));
    await userEvent.type(screen.getByLabelText("Reason for changes"), "Test edit");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Version conflict");
    expect(screen.getByLabelText("Reason for changes")).toHaveValue("Test edit");
    await userEvent.click(screen.getByRole("button", { name: "Discard edits and reload latest version" }));
    expect(screen.queryByLabelText("Reason for changes")).not.toBeInTheDocument();
  });
  it("shows source downloads, version snapshots and history pagination", async () => {
    const invoice: Invoice = { ...initialData.invoices[1], sourceFile: { name: "invoice.pdf", type: "application/pdf", size: 100 } };
    const detail = detailFor(invoice);
    const event: ReviewHistory = { ...detail.history.items[0], snapshot: invoice };
    mockApi({ handle: (call) => {
      if (call.path === "/invoices/inv-002") return json({ ...detail, history: { items: [event], total: 26, page: 1, limit: 25 } });
      if (call.path.endsWith("/history")) return json({ items: [{ ...event, id: "older", detail: "Earlier review event" }], total: 26, page: 2, limit: 25 });
      if (call.path.endsWith("/document")) return new Response("pdf");
    } });
    renderApp("/invoices/inv-002");
    await userEvent.click(await screen.findByRole("button", { name: "Download source document" }));
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled());
    await userEvent.click(screen.getByText("View saved version 1"));
    expect(screen.getByText(/"invoiceNumber": "ALP-8837"/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Earlier review event")).toBeInTheDocument();
  });
  it("allows admin reopen, locks finalized records, and handles missing invoices", async () => {
    mockApi({ handle: (call) => call.path.endsWith("/review") ? json({ ok: true }) : undefined });
    const { router } = renderApp("/invoices/inv-007");
    await userEvent.type(await screen.findByLabelText("Review note"), "Need to correct an approved field.");
    await userEvent.click(screen.getByRole("button", { name: "Reopen invoice" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Reopen invoice saved");
    await router.navigate("/invoices/missing");
    expect(await screen.findByRole("alert")).toHaveTextContent("Invoice not found");
  });
  it("renders voided drafts without misleading matching or edit actions", async () => {
    const invoice: Invoice = { ...initialData.invoices[0], status: "voided", invoiceNumber: "", supplierId: "", purchaseOrderId: "", deliveryRecordId: "", date: "", dueDate: "", lineItems: [], extractedFields: [] };
    mockApi({ data: { ...initialData, invoices: [invoice], reviewHistory: [] } });
    renderApp("/invoices/inv-001");
    expect(await screen.findByRole("heading", { name: "Unnumbered draft", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/This voided record is locked/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit invoice" })).not.toBeInTheDocument();
  });
});

describe("invoice intake", () => {
  it("creates a manual incomplete draft and navigates to its review", async () => {
    const data = structuredClone(initialData);
    const api = mockApi({ data, handle: (call) => {
      if (call.path === "/invoices" && call.method === "POST") return json({ id: "inv-001" }, 201);
    } });
    renderApp("/invoices/new");
    await userEvent.type(await screen.findByLabelText("Invoice number"), "MANUAL-1");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("heading", { name: "NFM-24081", level: 1 })).toBeInTheDocument();
    expect(api.calls.find((call) => call.method === "POST" && call.path === "/invoices")?.body).toMatchObject({ invoice: { invoiceNumber: "MANUAL-1", lineItems: [] } });
  });
  it("keeps the same creation request ID after a retryable failure", async () => {
    let fail = true;
    const api = mockApi({ handle: (call) => {
      if (call.path === "/invoices" && call.method === "POST") return fail ? apiError("Connection interrupted") : json({ id: "inv-001" }, 201);
    } });
    renderApp("/invoices/new");
    await userEvent.click(await screen.findByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("heading", { name: "NFM-24081", level: 1 });
    const requests = api.calls.filter((call) => call.path === "/invoices" && call.method === "POST");
    expect(requests[0].body).toEqual(requests[1].body);
  });
  it("validates uploads, clears invalid selection, and revokes image preview URLs", async () => {
    mockApi();
    const { unmount } = renderApp("/invoices/new");
    const input = await screen.findByLabelText("Invoice document");
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, new File(["bad"], "bad.txt", { type: "text/plain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PDF, PNG, or JPG");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Clear document" }));
    await user.upload(input, new File(["image"], "good.png", { type: "image/png" }));
    expect(await screen.findByAltText("Preview of good.png")).toBeInTheDocument();
    await user.upload(input, new File([], "empty.png", { type: "image/png" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("non-empty");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    unmount();
  });
  it("submits a PDF and metadata as multipart, and rejects multiple dropped files", async () => {
    const api = mockApi({ handle: (call) => call.path === "/invoices" && call.method === "POST" ? json({ id: "inv-001" }, 201) : undefined });
    renderApp("/invoices/new");
    const user = userEvent.setup();
    const input = await screen.findByLabelText("Invoice document");
    const zone = input.closest(".drop-zone");
    if (!zone) throw new Error("Missing upload drop zone.");
    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["a"], "a.pdf", { type: "application/pdf" }), new File(["b"], "b.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("exactly one");
    await user.upload(input, new File(["%PDF-1.4 sample"], "invoice.pdf", { type: "application/pdf" }));
    expect(screen.getByText(/PDFs are stored/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("heading", { name: "NFM-24081", level: 1 });
    const body = api.calls.find((call) => call.method === "POST" && call.path === "/invoices")?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) throw new Error("Expected multipart body.");
    expect(body.get("document")).toBeInstanceOf(File);
  });
  it("loads PO lines, supports line edits and removal, and checks date ordering", async () => {
    mockApi();
    renderApp("/invoices/new");
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Supplier", { selector: "select" }), "sup-001");
    await user.selectOptions(await screen.findByLabelText("Purchase order", { selector: "select" }), "po-001");
    await user.selectOptions(await screen.findByLabelText("Delivery record", { selector: "select" }), "del-001");
    await user.click(await screen.findByRole("button", { name: /Use PO line items/ }));
    expect(screen.getByLabelText("Line 1 SKU")).toHaveValue("BRG-6204");
    await user.click(screen.getByRole("button", { name: "Remove line 2" }));
    await user.click(screen.getByRole("button", { name: "Add line item" }));
    await user.type(screen.getByLabelText("Line 2 SKU"), "NEW");
    await user.type(screen.getByLabelText("Line 2 description"), "New item");
    fireEvent.change(screen.getByLabelText("Invoice date"), { target: { value: "2026-10-02" } });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-10-01" } });
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("due date cannot precede");
    await user.selectOptions(screen.getByLabelText("Supplier", { selector: "select" }), "sup-002");
    expect(screen.getByLabelText("Purchase order", { selector: "select" })).toHaveValue("");
  });
});

describe("CSV exports", () => {
  it("creates a selected batch, clears selection, and downloads it", async () => {
    const api = mockApi({ handle: (call) => {
      if (call.path === "/exports" && call.method === "POST") return json({ id: "batch-1" }, 201);
      if (call.path.endsWith("/download")) return new Response("csv");
    } });
    renderApp("/exports");
    await userEvent.click(await screen.findByLabelText("Select invoice NFM-24096"));
    await userEvent.click(screen.getByRole("button", { name: "Create CSV export (1)" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Export batch saved");
    expect(api.calls.find((call) => call.path === "/exports" && call.method === "POST")?.body).toMatchObject({ invoices: [{ id: "inv-007", version: 1 }] });
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Create CSV export (0)" })).toBeDisabled();
  });
  it("distinguishes saved batches from failed downloads and keeps recovery history", async () => {
    let saved = false;
    mockApi({ handle: (call) => {
      if (call.path === "/exports" && call.method === "POST") { saved = true; return json({ id: "batch-1" }, 201); }
      if (call.path === "/exports" && saved) return json({ items: [{ id: "batch-1", createdAt: "2026-10-02T00:00:00Z", createdBy: "Alex", invoiceCount: 1 }], total: 1, page: 1, limit: 25 });
      if (call.path.endsWith("/download")) return apiError("Download interrupted");
    } });
    renderApp("/exports");
    await userEvent.click(await screen.findByLabelText("Select all invoices on this page"));
    await userEvent.click(screen.getByRole("button", { name: "Create CSV export (1)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("batch was saved, but the download failed");
    expect(await screen.findByRole("button", { name: "Download CSV" })).toBeInTheDocument();
  });
  it("does not clear a failed batch selection and supports clearing stale records", async () => {
    mockApi({ handle: (call) => call.path === "/exports" && call.method === "POST" ? apiError("Another user changed an invoice", 409) : undefined });
    renderApp("/exports");
    await userEvent.click(await screen.findByLabelText("Select invoice NFM-24096"));
    await userEvent.click(screen.getByRole("button", { name: "Create CSV export (1)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another user");
    expect(screen.getByLabelText("Select invoice NFM-24096")).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Clear selection and reload" }));
    expect(screen.getByRole("button", { name: "Create CSV export (0)" })).toBeDisabled();
  });
});

describe("reference data and accounts", () => {
  it("creates a supplier and searches existing records", async () => {
    const api = mockApi({ handle: (call) => call.path === "/suppliers" && call.method === "POST" ? json({ id: "new" }, 201) : undefined });
    renderApp("/reference-data");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Supplier name"), "New supplier");
    await user.type(screen.getByLabelText("Supplier code"), "NEW");
    await user.type(screen.getByLabelText("Location"), "Boston");
    await user.click(screen.getByRole("button", { name: "Create reference record" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Reference record saved");
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({ name: "New supplier", code: "NEW", location: "Boston" });
    await user.type(screen.getByLabelText("Search reference data"), "Northstar");
    await waitFor(() => expect(api.calls.some((call) => call.query.get("search") === "Northstar")).toBe(true));
  });
  it.each(["purchase-orders", "deliveries"] as const)("creates %s with line items and correct date fields", async (kind) => {
    const api = mockApi({ handle: (call) => call.path === `/${kind}` && call.method === "POST" ? json({ id: "new" }, 201) : undefined });
    renderApp(`/reference-data?kind=${kind}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(kind === "purchase-orders" ? "PO number" : "Receipt number"), "NEW-100");
    const select = screen.getByLabelText(kind === "purchase-orders" ? "Supplier" : "Purchase order", { selector: "select" });
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBeGreaterThan(1));
    await user.selectOptions(select, kind === "purchase-orders" ? "sup-001" : "po-001");
    fireEvent.change(screen.getByLabelText(kind === "purchase-orders" ? "Order date" : "Receipt date"), { target: { value: "2026-10-01" } });
    await user.click(screen.getByRole("button", { name: "Add line item" }));
    await user.type(screen.getByLabelText("Line 1 SKU"), "ITEM");
    await user.type(screen.getByLabelText("Line 1 description"), "An item");
    await user.click(screen.getByRole("button", { name: "Create reference record" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Reference record saved");
    expect(api.calls.find((call) => call.method === "POST")?.body).toMatchObject({ lineItems: [{ sku: "ITEM", description: "An item", quantity: 1 }] });
  });
  it("preserves reference input when the server rejects a record", async () => {
    mockApi({ handle: (call) => call.method === "POST" ? apiError("Duplicate supplier code", 409) : undefined });
    renderApp("/reference-data");
    await userEvent.type(await screen.findByLabelText("Supplier name"), "New supplier");
    await userEvent.type(screen.getByLabelText("Supplier code"), "DUPLICATE");
    await userEvent.click(screen.getByRole("button", { name: "Create reference record" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Duplicate supplier code");
    expect(screen.getByLabelText("Supplier code")).toHaveValue("DUPLICATE");
  });
  it("creates accounts without claiming an email was sent, then changes access", async () => {
    const api = mockApi({ handle: (call) => call.method === "POST" || call.method === "PATCH" ? json({ ok: true }) : undefined });
    renderApp("/users");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Full name"), "New Reviewer");
    await user.type(screen.getByLabelText("Email"), "new@example.test");
    await user.type(screen.getByLabelText("Temporary password", { exact: true }), "temporary-password-123");
    await user.selectOptions(screen.getByLabelText("Role", { exact: true }), "admin");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("status")).toHaveTextContent("no email was sent");
    expect(api.calls.find((call) => call.path === "/admin/users" && call.method === "POST")?.body).toMatchObject({ email: "new@example.test", role: "admin" });
    await user.selectOptions(screen.getByLabelText("Role for reviewer@example.test"), "admin");
    await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
    const row = screen.getByText("reviewer@example.test").closest("tr");
    if (!row) throw new Error("Missing reviewer row.");
    await user.click(within(row).getByRole("button", { name: "Disable account" }));
    expect(api.calls.filter((call) => call.method === "PATCH").at(-1)?.body).toMatchObject({ active: false });
  });
  it("resets a password, surfaces admin failures, and protects the current user's controls", async () => {
    let fail = true;
    mockApi({ handle: (call) => call.path.endsWith("/reset-password") ? fail ? apiError("Password reset unavailable") : json({ ok: true }) : undefined });
    renderApp("/users");
    await screen.findByText("Team Reviewer");
    expect(screen.getByLabelText("Role for alex@example.test")).toBeDisabled();
    const row = screen.getByText("reviewer@example.test").closest("tr");
    if (!row) throw new Error("Missing reviewer row.");
    await userEvent.click(within(row).getByText("Set temporary password"));
    await userEvent.type(within(row).getByLabelText("Temporary password for reviewer@example.test"), "temporary-password-456");
    await userEvent.click(within(row).getByRole("button", { name: "Reset password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reset unavailable");
    fail = false;
    await userEvent.click(within(row).getByRole("button", { name: "Reset password" }));
    expect(await within(row).findByRole("status")).toHaveTextContent("Temporary password set");
  });
});
