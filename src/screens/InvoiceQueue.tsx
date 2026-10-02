import { useState } from "react";
import type { Page } from "../App";
import type { InvoiceSummary, PageResult } from "../domain/api";
import { formatCurrency } from "../domain/money";
import { useDebouncedValue, useResource } from "../state/appState";
import { StatusPill, statusLabels } from "../components/StatusPill";
import { ErrorMessage, Loading, Pagination } from "../components/Feedback";

export function InvoiceQueue({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("date_desc");
  const [page, setPage] = useState(1);
  const term = useDebouncedValue(search);
  const resource = useResource<PageResult<InvoiceSummary>>(`/invoices?page=${page}&search=${encodeURIComponent(term)}&status=${status}&sort=${sort}`);
  return <div>
    <section className="page-heading split-heading"><div><span className="eyebrow">Accounts payable</span><h1>Invoice queue</h1><p>Search shared records and inspect server-validated matching evidence.</p></div><button className="button primary" onClick={() => onNavigate("upload")} type="button">New invoice</button></section>
    <section className="panel queue-panel">
      <div className="queue-toolbar">
        <label className="search-field"><span className="sr-only">Search invoices</span><span aria-hidden="true">S</span><input value={search} maxLength={100} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search invoice, supplier, or PO" /></label>
        <label><span className="sr-only">Filter by status</span><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="all">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label><span className="sr-only">Sort invoices</span><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="date_desc">Newest first</option><option value="date_asc">Oldest first</option><option value="amount_desc">Highest amount</option><option value="supplier">Supplier A-Z</option></select></label>
      </div>
      <ErrorMessage error={resource.error} onRetry={resource.reload} />
      {resource.loading && !resource.data && <Loading label="Loading invoices..." />}
      {resource.data && <>
        <div className="results-summary"><strong>{resource.data.total}</strong> matching invoices{resource.loading ? " - refreshing..." : ""}</div>
        <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Supplier</th><th>Date</th><th>Amount</th><th>Purchase order</th><th>Status</th><th>Exception reason</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>
          {resource.data.items.map((invoice) => <tr key={invoice.id}><td><button className="table-link" onClick={() => onNavigate({ name: "review", invoiceId: invoice.id })} type="button">{invoice.invoiceNumber || "Unnumbered draft"}</button></td><td><strong>{invoice.supplierName}</strong><small>{invoice.supplierCode}</small></td><td>{invoice.date || "Not entered"}</td><td className="amount-cell">{formatCurrency(invoice.total)}</td><td>{invoice.purchaseOrderNumber}</td><td><StatusPill status={invoice.status} /></td><td className="reason-cell">{invoice.exceptionReason || (invoice.status === "voided" ? "Voided record" : "No exception found")}</td><td><button type="button" className="icon-button" aria-label={`Review ${invoice.invoiceNumber || invoice.id}`} onClick={() => onNavigate({ name: "review", invoiceId: invoice.id })}>&gt;</button></td></tr>)}
        </tbody></table></div>
        {resource.data.items.length === 0 && <div className="empty-state"><strong>No invoices found</strong><p>Create an invoice or try another search or status filter.</p></div>}
        <Pagination {...resource.data} onPage={setPage} disabled={resource.loading} />
      </>}
    </section>
  </div>;
}
