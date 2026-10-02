import { z } from "zod";
import { invoiceTotal } from "./money.js";
import type { Invoice, InvoiceStatus } from "./types.js";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_INVOICE_TOTAL = 100_000_000;
export const documentTypes = ["application/pdf", "image/png", "image/jpeg"] as const;
export const invoiceStatuses = ["needs_review", "possible_duplicate", "matched", "ready_to_export", "correction_requested", "escalated", "exported", "voided"] as const;
export const editableStatuses: readonly InvoiceStatus[] = ["needs_review", "possible_duplicate", "matched", "correction_requested", "escalated"];

const text = (max: number) => z.string().normalize("NFKC").trim().max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Control characters are not allowed.");
export const identifierSchema = z.string().regex(/^[a-zA-Z0-9-]{1,80}$/, "Invalid identifier.");
const optionalIdentifier = z.union([identifierSchema, z.literal("")]);
export const dateSchema = z.iso.date();
const optionalDate = z.union([dateSchema, z.literal("")]);
const amount = z.number().finite().min(0).max(10_000_000).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, "Use at most two decimal places.");
const quantity = z.number().int().min(1).max(1_000_000);
const sku = text(80).min(1).transform((value) => value.toUpperCase());

export const lineItemSchema = z.object({
  sku,
  description: text(250).min(1),
  quantity,
  unitPrice: amount,
}).strict();

const lineItems = z.array(lineItemSchema).max(100).refine(
  (lines) => new Set(lines.map((line) => line.sku)).size === lines.length,
  "Each SKU may appear only once.",
);
const invoiceFields = z.object({
  invoiceNumber: text(100).transform((value) => value.replace(/\s+/g, " ")),
  supplierId: optionalIdentifier,
  date: optionalDate,
  dueDate: optionalDate,
  purchaseOrderId: optionalIdentifier,
  deliveryRecordId: optionalIdentifier,
  lineItems,
  tax: amount,
}).strict();

export const invoiceInputSchema = invoiceFields.refine(
  (invoice) => !invoice.date || !invoice.dueDate || invoice.dueDate >= invoice.date,
  { message: "The due date cannot precede the invoice date.", path: ["dueDate"] },
).refine(
  (invoice) => invoiceTotal(invoice.lineItems, invoice.tax) <= MAX_INVOICE_TOTAL,
  { message: "Invoice total exceeds the supported maximum of USD 100,000,000.", path: ["lineItems"] },
);
export type InvoiceInput = z.infer<typeof invoiceInputSchema>;
export const createInvoiceSchema = z.object({
  requestId: z.uuid(),
  invoice: invoiceInputSchema,
}).strict();
export const updateInvoiceSchema = z.object({
  version: z.number().int().positive(),
  invoice: invoiceInputSchema,
  note: text(1000).min(1, "Explain the change for the audit history."),
}).strict();
export const reviewSchema = z.object({
  version: z.number().int().positive(),
  action: z.enum(["approved", "correction_requested", "escalated", "reopened", "voided"]),
  note: text(1000),
}).strict().refine((value) => value.action === "approved" || value.note.length > 0, { message: "A reason is required for this action.", path: ["note"] });
export const exportSchema = z.object({
  requestId: z.uuid(),
  invoices: z.array(z.object({ id: identifierSchema, version: z.number().int().positive() }).strict()).min(1).max(500),
}).strict().refine((value) => new Set(value.invoices.map((invoice) => invoice.id)).size === value.invoices.length, "Do not include an invoice more than once.");

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12, "Use at least 12 characters.").max(128, "Use no more than 128 characters.").refine((value) => value.trim().length > 0, "A password cannot contain only whitespace.");
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict();
export const createUserSchema = z.object({
  email: emailSchema,
  name: text(100).min(1),
  role: z.enum(["admin", "reviewer"]),
  password: passwordSchema,
}).strict();
export const updateUserSchema = z.object({
  active: z.boolean(),
  role: z.enum(["admin", "reviewer"]),
}).strict();
export const resetPasswordSchema = z.object({ password: passwordSchema }).strict();
export const supplierSchema = z.object({ name: text(160).min(1), code: text(40).min(1), location: text(160) }).strict();
export const purchaseOrderSchema = z.object({
  poNumber: text(100).min(1),
  supplierId: identifierSchema,
  orderedDate: dateSchema,
  lineItems: lineItems.refine((lines) => lines.length > 0, "Add at least one line item."),
}).strict().refine((order) => invoiceTotal(order.lineItems, 0) <= MAX_INVOICE_TOTAL, "Purchase order total exceeds the supported maximum.");
export const deliverySchema = z.object({
  deliveryNumber: text(100).min(1),
  purchaseOrderId: identifierSchema,
  receivedDate: dateSchema,
  lineItems: z.array(lineItemSchema.omit({ unitPrice: true })).min(1).max(100).refine((lines) => new Set(lines.map((line) => line.sku)).size === lines.length, "Each SKU may appear only once."),
}).strict();
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: text(100).default(""),
});
export const invoiceQuerySchema = pageQuerySchema.extend({
  status: z.enum(["all", ...invoiceStatuses]).default("all"),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "supplier"]).default("date_desc"),
}).strict();
export const referenceQuerySchema = pageQuerySchema.extend({
  supplierId: identifierSchema.optional(),
  purchaseOrderId: identifierSchema.optional(),
}).strict();

export function emptyInvoiceInput(): InvoiceInput {
  return { invoiceNumber: "", supplierId: "", date: "", dueDate: "", purchaseOrderId: "", deliveryRecordId: "", lineItems: [], tax: 0 };
}

export function invoiceToInput(invoice: Invoice): InvoiceInput {
  return {
    invoiceNumber: invoice.invoiceNumber, supplierId: invoice.supplierId, date: invoice.date, dueDate: invoice.dueDate,
    purchaseOrderId: invoice.purchaseOrderId, deliveryRecordId: invoice.deliveryRecordId ?? "",
    lineItems: invoice.lineItems.map(({ sku, description, quantity, unitPrice }) => ({ sku, description, quantity, unitPrice })),
    tax: invoice.tax,
  };
}
