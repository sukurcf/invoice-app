import { describe, expect, it } from "vitest";
import { initialData } from "../data/demoData";
import {
  ALLOWED_PRICE_VARIANCE_PERCENT,
  checkFieldExceptions,
  checkPriceExceptions,
  checkQuantityExceptions,
  findDuplicate,
  getInvoiceExceptions,
  normalizedInvoiceNumber,
} from "./invoiceChecks";

describe("invoice checks", () => {
  it("finds a duplicate only for the same supplier and invoice number", () => {
    const duplicate = findDuplicate(initialData.invoices[3], initialData.invoices);
    expect(duplicate?.id).toBe("inv-005");
    expect(findDuplicate(initialData.invoices[0], initialData.invoices)).toBeUndefined();
  });

  it("calculates the requested price exception with monetary evidence", () => {
    const exceptions = checkPriceExceptions(initialData.invoices[1], initialData.purchaseOrders[1]);
    expect(ALLOWED_PRICE_VARIANCE_PERCENT).toBe(5);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].sourceValues).toContainEqual({ label: "Difference", value: "$15.00" });
    expect(exceptions[0].calculation).toContain("12.5%");
  });

  it("flags invoiced quantities above delivered quantities", () => {
    const exceptions = checkQuantityExceptions(initialData.invoices[2], initialData.deliveryRecords[2]);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].sourceValues).toContainEqual({ label: "Unreceived quantity", value: "6" });
  });

  it("flags low-confidence and missing extracted fields", () => {
    const exceptions = checkFieldExceptions(initialData.invoices[5].extractedFields);
    expect(exceptions.map((item) => item.type)).toEqual(["field_confidence", "missing_field"]);
  });

  it("normalizes duplicate numbers without matching blank or voided records", () => {
    const invoice = { ...initialData.invoices[3], invoiceNumber: "  ＭＥＲ-55210  " };
    expect(normalizedInvoiceNumber(invoice.invoiceNumber)).toBe("mer-55210");
    expect(findDuplicate(invoice, initialData.invoices)?.id).toBe("inv-005");
    expect(findDuplicate({ ...invoice, supplierId: "" }, initialData.invoices)).toBeUndefined();
    expect(findDuplicate({ ...invoice, invoiceNumber: "" }, initialData.invoices)).toBeUndefined();
    expect(findDuplicate(invoice, [{ ...initialData.invoices[4], status: "voided" }])).toBeUndefined();
    expect(findDuplicate({ ...invoice, supplierId: "different" }, initialData.invoices)).toBeUndefined();
  });
  it("uses exact tolerance boundaries instead of rounded percentages", () => {
    const order = { ...initialData.purchaseOrders[1], lineItems: [{ ...initialData.purchaseOrders[1].lineItems[0], unitPrice: 1000 }] };
    const invoice = { ...initialData.invoices[1], lineItems: [{ ...initialData.invoices[1].lineItems[0], unitPrice: 1050 }] };
    expect(checkPriceExceptions(invoice, order)).toHaveLength(0);
    expect(checkPriceExceptions({ ...invoice, lineItems: [{ ...invoice.lineItems[0], unitPrice: 1050.01 }] }, order)).toHaveLength(1);
    expect(checkPriceExceptions({ ...invoice, lineItems: [{ ...invoice.lineItems[0], unitPrice: 900 }] }, order)).toHaveLength(0);
  });
  it("flags positive charges against zero-price PO lines and unknown SKUs", () => {
    const invoice = initialData.invoices[1];
    const zeroOrder = { ...initialData.purchaseOrders[1], lineItems: [{ ...initialData.purchaseOrders[1].lineItems[0], unitPrice: 0 }] };
    expect(checkPriceExceptions(invoice, zeroOrder)[0].calculation).toContain("zero");
    expect(checkPriceExceptions({ ...invoice, lineItems: [{ ...invoice.lineItems[0], unitPrice: 0 }] }, zeroOrder)).toHaveLength(0);
    expect(checkPriceExceptions(invoice, initialData.purchaseOrders[0])[0].title).toContain("not on");
    expect(checkPriceExceptions(invoice)).toEqual([]);
  });
  it("reserves delivered and ordered quantities across approved and exported invoices", () => {
    const invoice = initialData.invoices[0];
    const committed = { ...invoice, id: "committed", invoiceNumber: "another", status: "ready_to_export" as const };
    const checks = getInvoiceExceptions(invoice, [invoice, committed], initialData.purchaseOrders[0], initialData.deliveryRecords[0]);
    expect(checks.filter((item) => item.type === "quantity")).toHaveLength(4);
    const notCommitted = { ...committed, status: "needs_review" as const };
    expect(getInvoiceExceptions(invoice, [invoice, notCommitted], initialData.purchaseOrders[0], initialData.deliveryRecords[0])).toHaveLength(0);
    expect(checkQuantityExceptions(invoice)).toEqual([]);
  });
  it("does not double reserve the current invoice and treats missing receipt SKUs as zero", () => {
    const invoice = { ...initialData.invoices[0], status: "ready_to_export" as const };
    expect(getInvoiceExceptions(invoice, [invoice], initialData.purchaseOrders[0], initialData.deliveryRecords[0])).toEqual([]);
    expect(checkQuantityExceptions(invoice, initialData.deliveryRecords[1])).toHaveLength(2);
  });
  it("checks required fields even if extraction metadata is empty or omitted", () => {
    const invoice = { ...initialData.invoices[0], invoiceNumber: "", supplierId: "", date: "", dueDate: "", lineItems: [], extractedFields: [] };
    expect(getInvoiceExceptions(invoice, [])).toHaveLength(7);
    const invalid = { ...initialData.invoices[0], tax: -1 };
    expect(getInvoiceExceptions(invalid, [], initialData.purchaseOrders[0], initialData.deliveryRecords[0]).some((item) => item.title.includes("tax"))).toBe(true);
  });
  it("flags cross-linked orders and receipts", () => {
    const checks = getInvoiceExceptions(initialData.invoices[0], [], initialData.purchaseOrders[1], initialData.deliveryRecords[1]);
    expect(checks.some((item) => item.title.includes("different supplier"))).toBe(true);
    expect(checks.some((item) => item.title.includes("different purchase order"))).toBe(true);
  });
  it("does not flag exact confidence thresholds or verified manual values", () => {
    expect(checkFieldExceptions([{ label: "Number", value: "A-1", confidence: 0.8, source: "demo_extraction" }])).toEqual([]);
    expect(checkFieldExceptions([{ label: "Number", value: "A-1", source: "manual" }])).toEqual([]);
    expect(getInvoiceExceptions({ ...initialData.invoices[0], status: "voided" }, [])).toEqual([]);
  });
});
