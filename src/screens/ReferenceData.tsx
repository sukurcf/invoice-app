import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import type { PageResult } from "../domain/api";
import type { DeliveryRecord, PurchaseOrder, Supplier } from "../domain/types";
import { deliverySchema, purchaseOrderSchema, supplierSchema, type InvoiceInput } from "../domain/validation";
import { useAppState, useDebouncedValue, useResource } from "../state/appState";
import { ErrorMessage, Loading, Pagination } from "../components/Feedback";
import { LineItemsEditor } from "../components/LineItemsEditor";
import { ReferenceSelect } from "../components/ReferenceSelect";
import { UnsavedChanges } from "../components/UnsavedChanges";

type Kind = "suppliers" | "purchase-orders" | "deliveries";
const titles: Record<Kind, string> = { suppliers: "Suppliers", "purchase-orders": "Purchase orders", deliveries: "Goods receipts" };

function ReferenceForm({ kind }: { kind: Kind }) {
  const { request, refresh } = useAppState();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [location, setLocation] = useState("");
  const [number, setNumber] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [date, setDate] = useState("");
  const [lines, setLines] = useState<InvoiceInput["lineItems"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null); setNotice("");
    setBusy(true);
    try {
      const body = kind === "suppliers" ? supplierSchema.parse({ name, code, location }) : kind === "purchase-orders"
        ? purchaseOrderSchema.parse({ poNumber: number, supplierId, orderedDate: date, lineItems: lines })
        : deliverySchema.parse({ deliveryNumber: number, purchaseOrderId, receivedDate: date, lineItems: lines.map(({ sku, description, quantity }) => ({ sku, description, quantity })) });
      await request(`/${kind}`, { method: "POST", body });
      setName(""); setCode(""); setLocation(""); setNumber(""); setSupplierId(""); setPurchaseOrderId(""); setDate(""); setLines([]);
      setNotice("Reference record saved. It is now available for invoice matching."); refresh();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <form className="catalog-form panel-padding" onSubmit={(event) => void submit(event)}>
    <UnsavedChanges dirty={!busy && Boolean(name || code || location || number || supplierId || purchaseOrderId || date || lines.length)} />
    <fieldset disabled={busy}>
      {kind === "suppliers" ? <div className="form-grid">
        <label>Supplier name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} /></label>
        <label>Supplier code<input value={code} onChange={(event) => setCode(event.target.value)} required maxLength={40} /></label>
        <label>Location<input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={160} /></label>
      </div> : <>
        <div className="form-grid">
          <label>{kind === "purchase-orders" ? "PO number" : "Receipt number"}<input value={number} onChange={(event) => setNumber(event.target.value)} required maxLength={100} /></label>
          {kind === "purchase-orders" ? <ReferenceSelect kind="suppliers" label="Supplier" value={supplierId} onChange={setSupplierId} required /> : <ReferenceSelect kind="purchase-orders" label="Purchase order" value={purchaseOrderId} onChange={setPurchaseOrderId} required />}
          <label>{kind === "purchase-orders" ? "Order date" : "Receipt date"}<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
        </div><LineItemsEditor lines={lines} onChange={setLines} showPrice={kind === "purchase-orders"} />
      </>}
      <div className="form-actions"><button className="button primary" type="submit">{busy ? "Saving..." : "Create reference record"}</button></div>
    </fieldset>
    <ErrorMessage error={error} />
    {notice && <p role="status" className="notice">{notice}</p>}
  </form>;
}

export function ReferenceData() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("kind");
  const kind: Kind = requested === "purchase-orders" || requested === "deliveries" ? requested : "suppliers";
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const term = useDebouncedValue(search);
  const resource = useResource<PageResult<Supplier | PurchaseOrder | DeliveryRecord>>(`/${kind}?page=${page}&search=${encodeURIComponent(term)}`);
  return <div>
    <section className="page-heading"><span className="eyebrow">Administration</span><h1>Reference data</h1><p>Set up suppliers, purchase orders, and goods receipts before matching invoices.</p></section>
    <div className="info-card"><p>Reference records are immutable to preserve approval evidence. Verify them before saving; use a new reference number for a replacement. An invoice links to one PO and one goods receipt.</p></div>
    <nav className="tabs" aria-label="Reference data categories">{(["suppliers", "purchase-orders", "deliveries"] as const).map((item) => <button className={kind === item ? "button primary" : "button secondary"} type="button" aria-pressed={kind === item} key={item} onClick={() => { setParams({ kind: item }); setPage(1); setSearch(""); }}>{titles[item]}</button>)}</nav>
    <section className="panel"><div className="panel-header"><div><h2>Create {kind === "suppliers" ? "supplier" : kind === "purchase-orders" ? "purchase order" : "goods receipt"}</h2><p>Only administrators can create reference data</p></div></div><ReferenceForm key={kind} kind={kind} /></section>
    <section className="panel spaced-panel"><div className="panel-header"><h2>{titles[kind]}</h2><label><span className="sr-only">Search reference data</span><input maxLength={100} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search reference data" /></label></div>
      <ErrorMessage error={resource.error} onRetry={resource.reload} />
      {resource.loading && !resource.data && <Loading />}
      {resource.data && <><div className="table-wrap"><table><thead><tr><th>Reference</th><th>Details</th></tr></thead><tbody>{resource.data.items.map((item) => <tr key={item.id}><td>{"name" in item ? <><strong>{item.name}</strong><small>{item.code}</small></> : "poNumber" in item ? item.poNumber : item.deliveryNumber}</td><td>{"location" in item ? item.location || "-" : <details><summary>{item.lineItems.length} line item(s) - {"orderedDate" in item ? item.orderedDate : item.receivedDate}</summary><ul>{item.lineItems.map((line) => <li key={line.id}>{line.sku}: {line.quantity} x {line.description}</li>)}</ul></details>}</td></tr>)}</tbody></table></div>{resource.data.total === 0 && <p className="empty-state">No reference records found. Create one above to get started.</p>}<Pagination {...resource.data} onPage={setPage} disabled={resource.loading} /></>}
    </section>
  </div>;
}
