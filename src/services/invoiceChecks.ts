import type {
  DeliveryRecord,
  ExceptionEvidence,
  ExtractedField,
  Invoice,
  PurchaseOrder,
} from "../domain/types.js";
import { formatCurrency, lineTotal, roundMoney } from "../domain/money.js";
import { dateSchema, invoiceInputSchema } from "../domain/validation.js";

export const ALLOWED_PRICE_VARIANCE_PERCENT = 5;
export const MINIMUM_FIELD_CONFIDENCE = 0.8;

export function normalizedInvoiceNumber(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function findDuplicate(
  invoice: Invoice,
  allInvoices: Invoice[],
): Invoice | undefined {
  if (!invoice.supplierId || !invoice.invoiceNumber.trim() || invoice.status === "voided") return undefined;
  return allInvoices.find(
    (candidate) =>
      candidate.id !== invoice.id &&
      candidate.status !== "voided" &&
      candidate.supplierId === invoice.supplierId &&
      normalizedInvoiceNumber(candidate.invoiceNumber) === normalizedInvoiceNumber(invoice.invoiceNumber),
  );
}

export function checkPriceExceptions(
  invoice: Invoice,
  purchaseOrder?: PurchaseOrder,
): ExceptionEvidence[] {
  if (!purchaseOrder) return [];

  return invoice.lineItems.flatMap((invoiceLine) => {
    const poLine = purchaseOrder.lineItems.find((line) => line.sku === invoiceLine.sku);
    if (!poLine) return [missingEvidence(`sku-${invoiceLine.id}`, `SKU ${invoiceLine.sku} is not on the purchase order`)];
    const invoiceCents = Math.round(invoiceLine.unitPrice * 100);
    const orderCents = Math.round(poLine.unitPrice * 100);
    if (invoiceCents * 100 <= orderCents * (100 + ALLOWED_PRICE_VARIANCE_PERCENT)) return [];

    const increasePercent = poLine.unitPrice === 0 ? undefined : roundMoney(
      ((invoiceLine.unitPrice - poLine.unitPrice) / poLine.unitPrice) * 100,
    );
    const difference = roundMoney(
      lineTotal(invoiceLine.quantity, invoiceLine.unitPrice) -
        lineTotal(invoiceLine.quantity, poLine.unitPrice),
    );

    return [{
      id: `price-${invoiceLine.id}`,
      type: "price" as const,
      title: `Price exceeds PO tolerance for ${invoiceLine.sku}`,
      explanation: `The invoice unit price exceeds the ${ALLOWED_PRICE_VARIANCE_PERCENT}% tolerance. Comparisons use exact cents; displayed percentages are rounded.`,
      severity: "high" as const,
      sourceValues: [
        { label: "Invoice", value: `${invoiceLine.quantity} x ${formatCurrency(invoiceLine.unitPrice)}` },
        { label: "Purchase order", value: `${invoiceLine.quantity} x ${formatCurrency(poLine.unitPrice)}` },
        { label: "Difference", value: formatCurrency(difference) },
      ],
      calculation: increasePercent === undefined ? "The PO price is zero; a positive invoice price requires correction." : `(${formatCurrency(invoiceLine.unitPrice)} - ${formatCurrency(poLine.unitPrice)}) / ${formatCurrency(poLine.unitPrice)} = ${increasePercent}%`,
    }];
  });
}

export function checkQuantityExceptions(
  invoice: Invoice,
  delivery?: DeliveryRecord,
  allInvoices: Invoice[] = [],
): ExceptionEvidence[] {
  if (!delivery) return [];

  return invoice.lineItems.flatMap((invoiceLine) => {
    const deliveryLine = delivery.lineItems.find((line) => line.sku === invoiceLine.sku);
    const committed = committedQuantity(invoice, allInvoices, invoiceLine.sku, "deliveryRecordId");
    const deliveredQuantity = Math.max(0, (deliveryLine?.quantity ?? 0) - committed);
    if (invoiceLine.quantity <= deliveredQuantity) return [];

    const difference = invoiceLine.quantity - deliveredQuantity;
    return [{
      id: `quantity-${invoiceLine.id}`,
      type: "quantity" as const,
      title: `Quantity exceeds delivery for ${invoiceLine.sku}`,
      explanation: `${difference} more unit${difference === 1 ? "" : "s"} were invoiced than remain available on this receipt. ${committed} unit(s) are already committed to other approved or exported invoices.`,
      severity: "high" as const,
      sourceValues: [
        { label: "Invoice quantity", value: String(invoiceLine.quantity) },
        { label: "Available delivered quantity", value: String(deliveredQuantity) },
        { label: "Unreceived quantity", value: String(difference) },
      ],
      calculation: `${invoiceLine.quantity} invoiced - ${deliveredQuantity} delivered = ${difference} unreceived`,
    }];
  });
}

export function checkFieldExceptions(fields: ExtractedField[]): ExceptionEvidence[] {
  return fields.flatMap<ExceptionEvidence>((field) => {
    if (!field.value.trim()) {
      return [{
        id: `missing-${field.label}`,
        type: "missing_field" as const,
        title: `Missing field: ${field.label}`,
        explanation: "A person must enter and verify this field before the invoice can be approved.",
        severity: "medium" as const,
        sourceValues: [{ label: field.label, value: "No value extracted" }],
      }];
    }
    if (field.confidence !== undefined && field.confidence < MINIMUM_FIELD_CONFIDENCE) {
      return [{
        id: `confidence-${field.label}`,
        type: "field_confidence" as const,
        title: `Check extracted ${field.label}`,
        explanation: "The extraction confidence is below the 80% review threshold. Verify the invoice fields and save the correction.",
        severity: "medium" as const,
        sourceValues: [
          { label: "Extracted value", value: field.value },
          { label: "Confidence", value: `${Math.round(field.confidence * 100)}%` },
        ],
        calculation: `${Math.round(field.confidence * 100)}% confidence < 80% threshold`,
      }];
    }
    return [];
  });
}

function missingEvidence(id: string, title: string): ExceptionEvidence {
  return { id: `required-${id}`, type: "missing_field", title, explanation: "Correct the invoice or its references before approval.", severity: "high", sourceValues: [] };
}

function committedQuantity(invoice: Invoice, allInvoices: Invoice[], sku: string, reference: "purchaseOrderId" | "deliveryRecordId"): number {
  return allInvoices.filter((other) =>
    other.id !== invoice.id && other[reference] === invoice[reference] &&
    (other.status === "ready_to_export" || other.status === "exported"),
  ).reduce((total, other) => total + other.lineItems.filter((line) => line.sku === sku).reduce((sum, line) => sum + line.quantity, 0), 0);
}

function checkRequiredFields(invoice: Invoice, purchaseOrder?: PurchaseOrder, delivery?: DeliveryRecord): ExceptionEvidence[] {
  const missing: ExceptionEvidence[] = [];
  if (!invoice.invoiceNumber.trim()) missing.push(missingEvidence("number", "Invoice number is required"));
  if (!invoice.supplierId || invoice.supplierId === "unassigned") missing.push(missingEvidence("supplier", "Supplier is required"));
  if (!dateSchema.safeParse(invoice.date).success) missing.push(missingEvidence("date", "A valid invoice date is required"));
  if (!dateSchema.safeParse(invoice.dueDate).success) missing.push(missingEvidence("due-date", "A valid due date is required"));
  if (!invoice.lineItems.length) missing.push(missingEvidence("lines", "At least one line item is required"));
  if (!purchaseOrder) missing.push(missingEvidence("po", "A purchase order is required"));
  else if (purchaseOrder.supplierId !== invoice.supplierId) missing.push(missingEvidence("po-supplier", "Purchase order belongs to a different supplier"));
  if (!delivery) missing.push(missingEvidence("delivery", "A delivery record is required"));
  else if (delivery.purchaseOrderId !== invoice.purchaseOrderId) missing.push(missingEvidence("delivery-po", "Delivery record belongs to a different purchase order"));
  const validation = invoiceInputSchema.safeParse({
    invoiceNumber: invoice.invoiceNumber, supplierId: invoice.supplierId, date: invoice.date, dueDate: invoice.dueDate,
    purchaseOrderId: invoice.purchaseOrderId, deliveryRecordId: invoice.deliveryRecordId ?? "",
    lineItems: invoice.lineItems.map(({ sku, description, quantity, unitPrice }) => ({ sku, description, quantity, unitPrice })),
    tax: invoice.tax,
  });
  if (!validation.success) {
    validation.error.issues.forEach((issue, index) => missing.push(missingEvidence(`invalid-${index}`, `${issue.path.join(".") || "Invoice"}: ${issue.message}`)));
  }
  return missing;
}

export function getInvoiceExceptions(
  invoice: Invoice,
  allInvoices: Invoice[],
  purchaseOrder?: PurchaseOrder,
  delivery?: DeliveryRecord,
): ExceptionEvidence[] {
  if (invoice.status === "voided") return [];
  const duplicate = findDuplicate(invoice, allInvoices);
  const duplicateEvidence: ExceptionEvidence[] = duplicate
    ? [{
        id: `duplicate-${duplicate.id}`,
        type: "duplicate",
        title: "Possible duplicate invoice",
        explanation: "Another invoice has the same supplier and invoice number.",
        severity: "high",
        sourceValues: [
          { label: "Supplier ID", value: invoice.supplierId },
          { label: "Invoice number", value: invoice.invoiceNumber },
          { label: "Existing record", value: duplicate.id },
        ],
      }]
    : [];

  const orderQuantityEvidence: ExceptionEvidence[] = purchaseOrder ? invoice.lineItems.flatMap((line) => {
    const ordered = purchaseOrder.lineItems.find((item) => item.sku === line.sku)?.quantity ?? 0;
    const available = Math.max(0, ordered - committedQuantity(invoice, allInvoices, line.sku, "purchaseOrderId"));
    return line.quantity <= available ? [] : [{
      id: `ordered-quantity-${line.id}`, type: "quantity" as const, title: `Quantity exceeds available PO units for ${line.sku}`,
      explanation: "Approved and exported invoices reserve PO quantities, including invoices linked to different receipts.",
      severity: "high" as const,
      sourceValues: [{ label: "Invoice quantity", value: String(line.quantity) }, { label: "Available PO quantity", value: String(available) }],
    }];
  }) : [];

  return [
    ...checkRequiredFields(invoice, purchaseOrder, delivery),
    ...duplicateEvidence,
    ...checkPriceExceptions(invoice, purchaseOrder),
    ...orderQuantityEvidence,
    ...checkQuantityExceptions(invoice, delivery, allInvoices),
    ...checkFieldExceptions(invoice.extractedFields),
  ];
}
