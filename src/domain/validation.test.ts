import { describe, expect, it } from "vitest";
import { initialData } from "../data/demoData";
import { createInvoiceSchema, createUserSchema, dateSchema, deliverySchema, emptyInvoiceInput, exportSchema, invoiceInputSchema, invoiceQuerySchema, invoiceToInput, passwordSchema, purchaseOrderSchema, reviewSchema, supplierSchema } from "./validation";

const valid = invoiceToInput(initialData.invoices[0]);

describe("shared input contracts", () => {
  it("allows incomplete drafts but strips no unknown fields", () => {
    expect(invoiceInputSchema.parse(emptyInvoiceInput())).toEqual(emptyInvoiceInput());
    expect(invoiceInputSchema.safeParse({ ...valid, status: "ready_to_export" }).success).toBe(false);
    expect(createInvoiceSchema.safeParse({ requestId: "invalid", invoice: valid }).success).toBe(false);
  });
  it.each([-1, 0.001, Infinity, NaN, 10_000_001])("rejects unsupported monetary values (%s)", (tax) => {
    expect(invoiceInputSchema.safeParse({ ...valid, tax }).success).toBe(false);
  });
  it.each([-1, 0, 1.5, 1_000_001])("rejects unsupported quantities (%s)", (quantity) => {
    expect(invoiceInputSchema.safeParse({ ...valid, lineItems: [{ ...valid.lineItems[0], quantity }] }).success).toBe(false);
  });
  it("enforces the total ceiling without floating-point proxies", () => {
    expect(invoiceInputSchema.safeParse({ ...valid, tax: 0, lineItems: [{ ...valid.lineItems[0], quantity: 1_000_000, unitPrice: 100 }] }).success).toBe(true);
    expect(invoiceInputSchema.safeParse({ ...valid, tax: 0.01, lineItems: [{ ...valid.lineItems[0], quantity: 1_000_000, unitPrice: 100 }] }).success).toBe(false);
  });
  it("normalizes whitespace and Unicode while rejecting control characters", () => {
    expect(invoiceInputSchema.parse({ ...valid, invoiceNumber: " ＡＢ  100 " }).invoiceNumber).toBe("AB 100");
    expect(invoiceInputSchema.safeParse({ ...valid, invoiceNumber: "bad\nnumber" }).success).toBe(false);
    expect(supplierSchema.safeParse({ name: "Supplier", code: "test\u0000", location: "" }).success).toBe(false);
  });
  it("rejects duplicate normalized SKUs and more than 100 lines", () => {
    const line = valid.lineItems[0];
    expect(invoiceInputSchema.safeParse({ ...valid, lineItems: [line, { ...line, sku: line.sku.toLowerCase() }] }).success).toBe(false);
    expect(invoiceInputSchema.safeParse({ ...valid, lineItems: Array.from({ length: 101 }, (_, i) => ({ ...line, sku: String(i) })) }).success).toBe(false);
  });
  it("accepts leap days only when valid and orders invoice dates", () => {
    expect(dateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(dateSchema.safeParse("2025-02-29").success).toBe(false);
    expect(invoiceInputSchema.safeParse({ ...valid, dueDate: "2026-01-01" }).success).toBe(false);
  });
  it("requires non-approval reasons and optimistic versions", () => {
    expect(reviewSchema.safeParse({ action: "approved", note: "", version: 1 }).success).toBe(true);
    for (const action of ["voided", "escalated", "correction_requested", "reopened"]) expect(reviewSchema.safeParse({ action, note: " ", version: 1 }).success).toBe(false);
    expect(reviewSchema.safeParse({ action: "approved", note: "", version: 0 }).success).toBe(false);
  });
  it("validates export size, identifiers and duplicate selections", () => {
    const requestId = crypto.randomUUID();
    expect(exportSchema.safeParse({ requestId, invoices: [] }).success).toBe(false);
    expect(exportSchema.safeParse({ requestId, invoices: [{ id: "invoice-1", version: 1 }, { id: "invoice-1", version: 2 }] }).success).toBe(false);
    expect(exportSchema.safeParse({ requestId, invoices: Array.from({ length: 501 }, (_, i) => ({ id: `inv-${i}`, version: 1 })) }).success).toBe(false);
  });
  it("requires strong length limits and normalized account data", () => {
    expect(passwordSchema.safeParse(" ".repeat(12)).success).toBe(false);
    expect(passwordSchema.safeParse("a".repeat(11)).success).toBe(false);
    expect(passwordSchema.safeParse("a".repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(129)).success).toBe(false);
    expect(createUserSchema.parse({ name: " Reviewer ", email: " USER@EXAMPLE.TEST ", password: "valid-passphrase", role: "reviewer" }).email).toBe("user@example.test");
    expect(createUserSchema.safeParse({ name: "a", email: "a@b.test", password: "valid-passphrase", role: "owner" }).success).toBe(false);
  });
  it("requires reference-data line items and dates", () => {
    expect(purchaseOrderSchema.safeParse({ poNumber: "PO-1", supplierId: "supplier-1", orderedDate: "2026-01-01", lineItems: [] }).success).toBe(false);
    expect(deliverySchema.safeParse({ deliveryNumber: "GRN-1", purchaseOrderId: "order-1", receivedDate: "invalid", lineItems: [{ sku: "A", description: "Item", quantity: 1 }] }).success).toBe(false);
  });
  it("defaults queue paging and rejects unsafe sort expressions", () => {
    expect(invoiceQuerySchema.parse({})).toEqual({ page: 1, limit: 25, search: "", status: "all", sort: "date_desc" });
    expect(invoiceQuerySchema.safeParse({ page: -1 }).success).toBe(false);
    expect(invoiceQuerySchema.safeParse({ sort: "date; DROP TABLE invoices" }).success).toBe(false);
  });
});
