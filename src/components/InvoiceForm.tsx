import { useState, type FormEvent } from "react";
import type { PurchaseOrder } from "../domain/types";
import { invoiceInputSchema, type InvoiceInput } from "../domain/validation";
import { formatCurrency, invoiceTotal } from "../domain/money";
import { useResource } from "../state/appState";
import { ErrorMessage } from "./Feedback";
import { ReferenceSelect } from "./ReferenceSelect";
import { LineItemsEditor } from "./LineItemsEditor";
import { UnsavedChanges } from "./UnsavedChanges";

export function InvoiceForm({ initial, onSave, editing = false, onCancel, disabled = false, hasDocument = false, labels }: {
  initial: InvoiceInput; onSave: (invoice: InvoiceInput, note: string) => Promise<void>; editing?: boolean; onCancel?: () => void;
  disabled?: boolean; hasDocument?: boolean; labels?: { supplier?: string; order?: string; delivery?: string };
}) {
  const [value, setValue] = useState(initial);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const order = useResource<PurchaseOrder>(value.purchaseOrderId ? `/purchase-orders/${encodeURIComponent(value.purchaseOrderId)}` : null);
  const dirty = JSON.stringify(value) !== JSON.stringify(initial) || note !== "" || hasDocument;
  const update = (change: Partial<InvoiceInput>) => setValue((previous) => ({ ...previous, ...change }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = invoiceInputSchema.safeParse(value);
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" ")); return; }
    if (editing && !note.trim()) { setError("Explain the change for the audit history."); return; }
    setBusy(true);
    try { await onSave(parsed.data, note.trim()); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <form className="invoice-form" onSubmit={(event) => void submit(event)}>
    <UnsavedChanges dirty={dirty && !busy} />
    <fieldset disabled={busy || disabled}>
      <p className="help-text">Incomplete drafts can be saved. Every matching exception must be resolved before approval. Use USD amounts and whole-unit quantities.</p>
      <div className="form-grid">
        <label>Invoice number<input maxLength={100} value={value.invoiceNumber} onChange={(event) => update({ invoiceNumber: event.target.value })} /></label>
        <ReferenceSelect kind="suppliers" label="Supplier" value={value.supplierId} initialLabel={labels?.supplier} onChange={(supplierId) => update({ supplierId, purchaseOrderId: "", deliveryRecordId: "" })} />
        <label>Invoice date<input type="date" value={value.date} onChange={(event) => update({ date: event.target.value })} /></label>
        <label>Due date<input type="date" value={value.dueDate} onChange={(event) => update({ dueDate: event.target.value })} /></label>
        <ReferenceSelect key={`po-${value.supplierId}`} kind="purchase-orders" label="Purchase order" value={value.purchaseOrderId} parentId={value.supplierId} initialLabel={labels?.order} disabled={!value.supplierId} onChange={(purchaseOrderId) => update({ purchaseOrderId, deliveryRecordId: "" })} />
        <ReferenceSelect key={`receipt-${value.purchaseOrderId}`} kind="deliveries" label="Delivery record" value={value.deliveryRecordId} parentId={value.purchaseOrderId} initialLabel={labels?.delivery} disabled={!value.purchaseOrderId} onChange={(deliveryRecordId) => update({ deliveryRecordId })} />
      </div>
      <ErrorMessage error={order.error} onRetry={order.reload} />
      {order.data && <button className="text-button" type="button" onClick={() => update({ lineItems: order.data!.lineItems.map(({ sku, description, quantity, unitPrice }) => ({ sku, description, quantity, unitPrice })) })}>Use PO line items (replaces current lines)</button>}
      <LineItemsEditor lines={value.lineItems} onChange={(lineItems) => update({ lineItems })} />
      <div className="form-grid"><label>Tax (USD)<input type="number" min={0} max={10_000_000} step="0.01" value={value.tax} required onChange={(event) => update({ tax: Number(event.target.value) })} /></label><p className="form-total">Invoice total: <strong>{formatCurrency(invoiceTotal(value.lineItems, value.tax))}</strong></p></div>
      {editing && <label>Reason for changes<textarea maxLength={1000} value={note} required onChange={(event) => setNote(event.target.value)} placeholder="Describe what you verified or corrected." /></label>}
      <div className="form-actions">{onCancel && <button className="button secondary" type="button" onClick={onCancel}>Discard edits</button>}<button className="button primary" type="submit">{busy ? "Saving..." : editing ? "Save changes" : "Save draft"}</button></div>
    </fieldset>
    <ErrorMessage error={error} />
  </form>;
}
