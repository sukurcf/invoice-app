import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import type pg from "pg";
import type { z } from "zod";
import type { Database } from "./database.js";
import { workflow } from "./database.js";
import { HttpError } from "./errors.js";
import { appendAudit, appendHistory, exceptionsFor, findInvoice, invoiceContext, referenceById } from "./repository.js";
import type { Invoice, InvoiceStatus, User } from "../src/domain/types.js";
import { documentTypes, editableStatuses, MAX_DOCUMENT_BYTES, type createInvoiceSchema, type exportSchema, type InvoiceInput, type reviewSchema, type updateInvoiceSchema } from "../src/domain/validation.js";
import { formatCurrency, invoiceTotal } from "../src/domain/money.js";
import { readyToExportCsv } from "../src/utils/csv.js";
import { normalizedInvoiceNumber } from "../src/services/invoiceChecks.js";

interface Document { name: string; type: string; bytes: Buffer }

export async function validateDocument(file?: Express.Multer.File): Promise<Document | undefined> {
  if (!file) return undefined;
  if (file.size < 12 || file.size > MAX_DOCUMENT_BYTES) throw new HttpError(400, "INVALID_DOCUMENT", "Choose a non-empty PDF, PNG, or JPG no larger than 10 MiB.");
  let detected;
  try {
    detected = await fileTypeFromBuffer(file.buffer);
  } catch (error) {
    if (error instanceof Error && error.name === "EndOfStreamError") throw new HttpError(400, "INVALID_DOCUMENT", "The document is truncated or invalid.");
    throw error;
  }
  if (!detected || !documentTypes.some((type) => type === detected.mime) || detected.mime !== file.mimetype) {
    throw new HttpError(400, "INVALID_DOCUMENT", "The document contents must match its PDF, PNG, or JPG file type.");
  }
  const name = basename(file.originalname.replaceAll("\\", "/")).normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  if (!name) throw new HttpError(400, "INVALID_DOCUMENT", "A document filename is required.");
  const extensions: Record<string, readonly string[]> = {
    "application/pdf": [".pdf"], "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"],
  };
  if (!extensions[detected.mime]?.includes(extname(name).toLowerCase())) {
    throw new HttpError(400, "INVALID_DOCUMENT", "The filename extension must match its PDF, PNG, or JPG contents.");
  }
  return { name, type: detected.mime, bytes: file.buffer };
}

async function validateReferences(db: Database, input: InvoiceInput): Promise<string> {
  const supplier = input.supplierId ? await referenceById(db, "suppliers", input.supplierId) : undefined;
  if (input.purchaseOrderId) {
    const order = await referenceById(db, "purchase-orders", input.purchaseOrderId);
    if (order.supplierId !== input.supplierId) throw new HttpError(422, "REFERENCE_MISMATCH", "The purchase order must belong to the selected supplier.");
  }
  if (input.deliveryRecordId) {
    const receipt = await referenceById(db, "deliveries", input.deliveryRecordId);
    if (receipt.purchaseOrderId !== input.purchaseOrderId) throw new HttpError(422, "REFERENCE_MISMATCH", "The delivery record must belong to the selected purchase order.");
  }
  return supplier?.name ?? "";
}

function fields(input: InvoiceInput, supplierName: string): Invoice["extractedFields"] {
  return [
    { label: "Invoice number", value: input.invoiceNumber, source: "manual" },
    { label: "Supplier", value: supplierName, source: "manual" },
    { label: "Invoice date", value: input.date, source: "manual" },
    { label: "Total", value: input.lineItems.length ? formatCurrency(invoiceTotal(input.lineItems, input.tax)) : "", source: "manual" },
  ];
}
async function checkedStatus(db: Database, invoice: Invoice): Promise<InvoiceStatus> {
  const exceptions = exceptionsFor(invoice, await invoiceContext(db, [invoice]));
  return exceptions.some((exception) => exception.type === "duplicate") ? "possible_duplicate" : exceptions.length ? "needs_review" : "matched";
}
function checkVersion(invoice: Invoice, version: number): void {
  if (invoice.version !== version) throw new HttpError(409, "VERSION_CONFLICT", "Another user changed this invoice. Reload it before continuing.");
}
function checkEditable(invoice: Invoice): void {
  if (!editableStatuses.includes(invoice.status)) throw new HttpError(409, "INVALID_TRANSITION", "This invoice is locked. An administrator must reopen an approved invoice; exported and voided invoices cannot be changed.");
}

export async function createInvoice(pool: pg.Pool, actor: User, input: z.infer<typeof createInvoiceSchema>, file?: Express.Multer.File): Promise<Invoice> {
  const document = await validateDocument(file);
  const fingerprint = createHash("sha256").update(JSON.stringify({ invoice: input.invoice, name: document?.name, type: document?.type, content: document ? createHash("sha256").update(document.bytes).digest("hex") : null })).digest("hex");
  return workflow(pool, actor, async (db) => {
    const existing = await db.query<{ request_fingerprint: string; created_by: string }>("SELECT request_fingerprint, created_by FROM invoices WHERE id = $1", [input.requestId]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_fingerprint !== fingerprint || existing.rows[0].created_by !== actor.id) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This request identifier was already used for a different invoice.");
      return findInvoice(db, input.requestId);
    }
    const supplierName = await validateReferences(db, input.invoice);
    const invoice: Invoice = {
      ...input.invoice, id: input.requestId, version: 1, currency: "USD", status: "needs_review",
      lineItems: input.invoice.lineItems.map((line) => ({ ...line, id: randomUUID() })),
      extractedFields: fields(input.invoice, supplierName),
      ...(document ? { sourceFile: { name: document.name, type: document.type, size: document.bytes.length } } : {}),
    };
    invoice.status = await checkedStatus(db, invoice);
    await db.query(`INSERT INTO invoices(id, invoice_number, supplier_id, issue_date, due_date, purchase_order_id, delivery_record_id,
      line_items, tax_cents, total_cents, status, extracted_fields, source_name, source_type, document, created_by, request_fingerprint, invoice_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18)`,
    [invoice.id, invoice.invoiceNumber, invoice.supplierId || null, invoice.date || null, invoice.dueDate || null, invoice.purchaseOrderId || null,
      invoice.deliveryRecordId || null, JSON.stringify(invoice.lineItems), Math.round(invoice.tax * 100), Math.round(invoiceTotal(invoice.lineItems, invoice.tax) * 100),
      invoice.status, JSON.stringify(invoice.extractedFields), document?.name ?? null, document?.type ?? null, document?.bytes ?? null, actor.id, fingerprint, normalizedInvoiceNumber(invoice.invoiceNumber)]);
    await appendHistory(db, invoice, actor, "created", "Draft created for manual review. OCR is not configured.");
    return invoice;
  });
}

export async function updateInvoice(pool: pg.Pool, actor: User, id: string, input: z.infer<typeof updateInvoiceSchema>): Promise<Invoice> {
  return workflow(pool, actor, async (db) => {
    const previous = await findInvoice(db, id);
    checkVersion(previous, input.version);
    checkEditable(previous);
    const supplierName = await validateReferences(db, input.invoice);
    const invoice: Invoice = { ...previous, ...input.invoice, version: previous.version + 1, lineItems: input.invoice.lineItems.map((line) => ({ ...line, id: randomUUID() })), extractedFields: fields(input.invoice, supplierName) };
    invoice.status = await checkedStatus(db, invoice);
    await db.query(`UPDATE invoices SET invoice_number=$2, supplier_id=$3, issue_date=$4, due_date=$5, purchase_order_id=$6, delivery_record_id=$7,
      line_items=$8::jsonb, tax_cents=$9, total_cents=$10, status=$11, extracted_fields=$12::jsonb, version=$13, invoice_key=$14, updated_at=now() WHERE id=$1`,
    [id, invoice.invoiceNumber, invoice.supplierId || null, invoice.date || null, invoice.dueDate || null, invoice.purchaseOrderId || null, invoice.deliveryRecordId || null,
      JSON.stringify(invoice.lineItems), Math.round(invoice.tax * 100), Math.round(invoiceTotal(invoice.lineItems, invoice.tax) * 100), invoice.status, JSON.stringify(invoice.extractedFields), invoice.version, normalizedInvoiceNumber(invoice.invoiceNumber)]);
    await appendHistory(db, invoice, actor, "updated", `Fields verified and updated: ${input.note}`);
    return invoice;
  });
}

export async function reviewInvoice(pool: pg.Pool, actor: User, id: string, input: z.infer<typeof reviewSchema>): Promise<Invoice> {
  return workflow(pool, actor, async (db) => {
    const invoice = await findInvoice(db, id);
    checkVersion(invoice, input.version);
    if (input.action === "reopened") {
      if (invoice.status !== "ready_to_export") throw new HttpError(409, "INVALID_TRANSITION", "Only an approved, unexported invoice can be reopened.");
    } else {
      checkEditable(invoice);
    }
    if (input.action === "approved") {
      const exceptions = exceptionsFor(invoice, await invoiceContext(db, [invoice]));
      if (exceptions.length) throw new HttpError(422, "UNRESOLVED_EXCEPTIONS", "Resolve every invoice exception before approval.", { exceptions });
    }
    const statuses: Record<z.infer<typeof reviewSchema>["action"], InvoiceStatus> = {
      approved: "ready_to_export", correction_requested: "correction_requested", escalated: "escalated", reopened: "needs_review", voided: "voided",
    };
    const updated: Invoice = { ...invoice, status: statuses[input.action], version: invoice.version + 1 };
    await db.query("UPDATE invoices SET status=$2, version=$3, updated_at=now() WHERE id=$1", [id, updated.status, updated.version]);
    const messages = {
      approved: "Approved for CSV export.", correction_requested: "Correction requested internally; no supplier message was sent.",
      escalated: "Escalated for internal review.", reopened: "Approval revoked; invoice reopened for review.", voided: "Invoice voided; it no longer blocks duplicate checks.",
    };
    await appendHistory(db, updated, actor, input.action, `${messages[input.action]}${input.note ? ` Reason: ${input.note}` : ""}`);
    return updated;
  }, input.action === "reopened");
}

export async function createExport(pool: pg.Pool, actor: User, input: z.infer<typeof exportSchema>): Promise<{ id: string }> {
  return workflow(pool, actor, async (db) => {
    const requested = [...input.invoices].sort((a, b) => a.id.localeCompare(b.id));
    const { rows } = await db.query<{ created_by: string; request: typeof requested }>("SELECT created_by, request FROM export_batches WHERE id=$1", [input.requestId]);
    if (rows[0]) {
      if (rows[0].created_by !== actor.id || JSON.stringify(rows[0].request) !== JSON.stringify(requested)) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This request identifier was already used for a different export.");
      return { id: input.requestId };
    }
    const invoices: Invoice[] = [];
    for (const selection of requested) {
      const invoice = await findInvoice(db, selection.id);
      checkVersion(invoice, selection.version);
      if (invoice.status !== "ready_to_export") throw new HttpError(409, "NOT_EXPORTABLE", "Only approved, unexported invoices can be exported.");
      invoices.push(invoice);
    }
    const context = await invoiceContext(db, invoices);
    for (const invoice of invoices) {
      if (exceptionsFor(invoice, context).length) throw new HttpError(422, "UNRESOLVED_EXCEPTIONS", `${invoice.invoiceNumber} now has blocking exceptions. Reopen or resolve related records before export.`);
    }
    const csv = readyToExportCsv({ invoices, suppliers: context.suppliers, purchaseOrders: context.purchaseOrders });
    await db.query("INSERT INTO export_batches(id, created_by, request, invoice_ids, csv) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)",
      [input.requestId, actor.id, JSON.stringify(requested), JSON.stringify(invoices.map((invoice) => invoice.id)), csv]);
    for (const invoice of invoices) {
      const exported: Invoice = { ...invoice, status: "exported", version: invoice.version + 1, exportBatchId: input.requestId };
      await db.query("UPDATE invoices SET status='exported', version=$2, export_batch_id=$3, updated_at=now() WHERE id=$1", [invoice.id, exported.version, input.requestId]);
      await appendHistory(db, exported, actor, "exported", `Included in CSV export ${input.requestId}. No ERP or payment system was contacted.`);
    }
    await appendAudit(db, actor, "export_created", input.requestId, `Created an immutable CSV batch containing ${invoices.length} invoice(s).`);
    return { id: input.requestId };
  });
}
