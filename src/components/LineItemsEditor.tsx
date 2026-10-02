import type { InvoiceInput } from "../domain/validation";
import { formatCurrency, invoiceSubtotal } from "../domain/money";

export function LineItemsEditor({ lines, onChange, showPrice = true }: { lines: InvoiceInput["lineItems"]; onChange: (lines: InvoiceInput["lineItems"]) => void; showPrice?: boolean }) {
  const update = (index: number, change: Partial<InvoiceInput["lineItems"][number]>) => onChange(lines.map((line, position) => position === index ? { ...line, ...change } : line));
  return <section className="line-editor">
    <div className="section-heading"><h2>Line items</h2><button type="button" className="button secondary" disabled={lines.length >= 100} onClick={() => onChange([...lines, { sku: "", description: "", quantity: 1, unitPrice: 0 }])}>Add line item</button></div>
    {lines.length === 0 && <p className="help-text">No line items yet. Add items to complete matching and approval.</p>}
    {lines.map((line, index) => <fieldset className="line-item-fields" key={index}><legend>Line {index + 1}</legend>
      <label>SKU<input aria-label={`Line ${index + 1} SKU`} value={line.sku} maxLength={80} required onChange={(event) => update(index, { sku: event.target.value })} /></label>
      <label>Description<input aria-label={`Line ${index + 1} description`} value={line.description} maxLength={250} required onChange={(event) => update(index, { description: event.target.value })} /></label>
      <label>Quantity<input aria-label={`Line ${index + 1} quantity`} type="number" min={1} max={1_000_000} step={1} value={line.quantity} required onChange={(event) => update(index, { quantity: Number(event.target.value) })} /></label>
      {showPrice && <label>Unit price (USD)<input aria-label={`Line ${index + 1} unit price`} type="number" min={0} max={10_000_000} step="0.01" value={line.unitPrice} required onChange={(event) => update(index, { unitPrice: Number(event.target.value) })} /></label>}
      <button type="button" className="text-button danger-outline" aria-label={`Remove line ${index + 1}`} onClick={() => onChange(lines.filter((_, position) => position !== index))}>Remove</button>
    </fieldset>)}
    {showPrice && <p className="form-total">Subtotal: <strong>{formatCurrency(invoiceSubtotal(lines))}</strong></p>}
  </section>;
}
