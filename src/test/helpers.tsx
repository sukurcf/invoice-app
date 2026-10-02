import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { vi } from "vitest";
import App from "../App";
import { initialData } from "../data/demoData";
import type { AppData, Invoice, User } from "../domain/types";
import type { DashboardData, InvoiceDetail, InvoiceSummary, Session } from "../domain/api";
import { invoiceTotal } from "../domain/money";
import { getInvoiceExceptions } from "../services/invoiceChecks";
import { AppStateProvider } from "../state/appState";

export const admin: User = { id: "admin-1", name: "Alex Reviewer", email: "alex@example.test", role: "admin", active: true, mustChangePassword: false };
export const reviewer: User = { ...admin, id: "reviewer-1", role: "reviewer" };
export const session: Session = { user: admin, csrfToken: "a".repeat(64) };
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
export function apiError(message: string, status = 500, code = "ERROR"): Response {
  return json({ error: { code, message }, requestId: "test-request" }, status);
}
export function detailFor(invoice: Invoice, data = initialData): InvoiceDetail {
  const supplier = data.suppliers.find((item) => item.id === invoice.supplierId);
  const purchaseOrder = data.purchaseOrders.find((item) => item.id === invoice.purchaseOrderId);
  const delivery = data.deliveryRecords.find((item) => item.id === invoice.deliveryRecordId);
  const history = data.reviewHistory.filter((item) => item.invoiceId === invoice.id).map((event) => ({ ...event, version: 1, snapshot: invoice }));
  return { invoice, supplier, purchaseOrder, delivery, exceptions: getInvoiceExceptions(invoice, data.invoices, purchaseOrder, delivery), history: { items: history, page: 1, total: history.length, limit: 25 } };
}
export function summaryFor(invoice: Invoice, data = initialData): InvoiceSummary {
  const detail = detailFor(invoice, data);
  return { id: invoice.id, invoiceNumber: invoice.invoiceNumber, date: invoice.date, dueDate: invoice.dueDate, status: invoice.status, version: invoice.version,
    supplierName: detail.supplier?.name ?? "Not assigned", supplierCode: detail.supplier?.code ?? "", purchaseOrderNumber: detail.purchaseOrder?.poNumber ?? "",
    total: invoiceTotal(invoice.lineItems, invoice.tax), exceptionCount: detail.exceptions.length, exceptionReason: detail.exceptions[0]?.title ?? "" };
}
export interface ApiCall { path: string; query: URLSearchParams; method: string; body: unknown; headers: Headers; signal: AbortSignal | null | undefined }
export function mockApi(options: {
  user?: User; data?: AppData;
  handle?: (call: ApiCall) => Response | undefined | Promise<Response | undefined>;
} = {}) {
  const calls: ApiCall[] = [];
  const data = options.data ?? structuredClone(initialData);
  const user = options.user ?? admin;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    const call: ApiCall = {
      path: url.pathname.replace(/^\/api/, ""), query: url.searchParams, method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      headers: new Headers(init?.headers), signal: init?.signal,
    };
    calls.push(call);
    const override = await options.handle?.(call);
    if (override) return override;
    if (call.path === "/auth/me" || call.path === "/auth/login" || call.path === "/auth/change-password") return json({ user, csrfToken: session.csrfToken });
    if (call.path === "/auth/logout") return json({ ok: true });
    if (call.path === "/dashboard") {
      const counts: DashboardData["counts"] = { needs_review: 0, matched: 0, possible_duplicate: 0, ready_to_export: 0, correction_requested: 0, escalated: 0, exported: 0, voided: 0 };
      for (const invoice of data.invoices) counts[invoice.status]++;
      return json({ counts, priority: data.invoices.filter((invoice) => ["needs_review", "possible_duplicate", "escalated"].includes(invoice.status)).slice(0, 4).map((invoice) => summaryFor(invoice, data)), history: data.reviewHistory.slice(0, 5) } satisfies DashboardData);
    }
    if (call.path === "/invoices" && call.method === "GET") {
      const status = call.query.get("status");
      const search = call.query.get("search")?.toLowerCase() ?? "";
      const filtered = data.invoices.map((invoice) => summaryFor(invoice, data)).filter((invoice) => (!status || status === "all" || invoice.status === status) && (!search || `${invoice.invoiceNumber} ${invoice.supplierName} ${invoice.purchaseOrderNumber}`.toLowerCase().includes(search)));
      const page = Number(call.query.get("page") ?? 1);
      const limit = Number(call.query.get("limit") ?? 25);
      return json({ items: filtered.slice((page - 1) * limit, page * limit), total: filtered.length, page, limit });
    }
    if (/^\/invoices\/[^/]+$/.test(call.path) && call.method === "GET") {
      const invoice = data.invoices.find((item) => item.id === call.path.split("/")[2]);
      return invoice ? json(detailFor(invoice, data)) : apiError("Invoice not found.", 404, "NOT_FOUND");
    }
    for (const [kind, items] of [["suppliers", data.suppliers], ["purchase-orders", data.purchaseOrders], ["deliveries", data.deliveryRecords]] as const) {
      if (call.path === `/${kind}` && call.method === "GET") return json({ items, total: items.length, page: 1, limit: 20 });
      if (call.path.startsWith(`/${kind}/`) && call.method === "GET") {
        const item = items.find((item) => item.id === call.path.split("/")[2]);
        return item ? json(item) : apiError("Reference not found.", 404);
      }
    }
    if (call.path === "/exports" && call.method === "GET") return json({ items: [], total: 0, page: 1, limit: 25 });
    if (call.path === "/admin/users" && call.method === "GET") return json({ items: [admin, { ...reviewer, email: "reviewer@example.test", name: "Team Reviewer" }], total: 2, page: 1, limit: 25 });
    if (call.path === "/admin/audit") return json({ items: [], total: 0, page: 1, limit: 25 });
    return apiError(`Unhandled test request: ${call.method} ${call.path}`, 500);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch, data };
}
export function renderApp(path = "/") {
  const router = createMemoryRouter([{ path: "*", element: <App /> }], { initialEntries: [path] });
  const result = render(<AppStateProvider><RouterProvider router={router} /></AppStateProvider>);
  return { ...result, router };
}
