import { useRef, useState } from "react";
import type { ExportBatch, InvoiceSummary, PageResult } from "../domain/api";
import { formatCurrency } from "../domain/money";
import { errorMessage } from "../services/api";
import { useAppState, useResource } from "../state/appState";
import { DownloadButton, ErrorMessage, Loading, Pagination } from "../components/Feedback";

export function Exports() {
  const { request, download, refresh } = useAppState();
  const [page, setPage] = useState(1);
  const [batchPage, setBatchPage] = useState(1);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | null>(null);
  const approved = useResource<PageResult<InvoiceSummary>>(`/invoices?status=ready_to_export&page=${page}&sort=date_asc`);
  const batches = useResource<PageResult<ExportBatch>>(`/exports?page=${batchPage}`);
  const count = Object.keys(selected).length;
  const choose = (invoices: InvoiceSummary[], checked: boolean) => {
    const next = { ...selected };
    for (const invoice of invoices) {
      if (checked) next[invoice.id] = invoice.version;
      else delete next[invoice.id];
    }
    if (Object.keys(next).length > 500) { setError("An export batch can contain at most 500 invoices."); return; }
    requestId.current = null;
    setSelected(next);
  };
  const clearSelection = () => { setSelected({}); requestId.current = null; setError(null); approved.reload(); };
  const createBatch = async () => {
    setBusy(true); setError(null); setNotice("");
    requestId.current ??= crypto.randomUUID();
    try {
      const result = await request<{ id: string }>("/exports", { method: "POST", body: {
        requestId: requestId.current, invoices: Object.entries(selected).map(([id, version]) => ({ id, version })),
      } });
      setSelected({}); requestId.current = null; setBatchPage(1);
      setNotice("Export batch saved. Included invoices are locked; this CSV can be downloaded again from export history.");
      refresh();
      try { await download(`/exports/${result.id}/download`, `invoices-${result.id}.csv`); }
      catch (cause) { setError(`The batch was saved, but the download failed. Use export history to download it again. ${errorMessage(cause)}`); }
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <div>
    <section className="page-heading"><span className="eyebrow">Controlled CSV handoff</span><h1>Exports</h1><p>Export approved invoices once, retain the exact CSV, and download it again without creating another export.</p></section>
    <ErrorMessage error={error} />
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel">
      <div className="panel-header"><div><h2>Approved invoices</h2><p>Select up to 500 records across pages. Creating a batch locks its invoices.</p></div></div>
      <ErrorMessage error={approved.error} onRetry={approved.reload} />
      {approved.loading && !approved.data && <Loading />}
      {approved.data && <>
        <div className="table-wrap"><table><thead><tr><th><input className="checkbox" type="checkbox" aria-label="Select all invoices on this page" disabled={busy || approved.data.items.length === 0} checked={approved.data.items.length > 0 && approved.data.items.every((invoice) => selected[invoice.id] !== undefined)} onChange={(event) => choose(approved.data!.items, event.target.checked)} /></th><th>Invoice</th><th>Supplier</th><th>Total</th><th>Current checks</th></tr></thead><tbody>{approved.data.items.map((invoice) => <tr key={invoice.id}><td><input className="checkbox" type="checkbox" aria-label={`Select invoice ${invoice.invoiceNumber}`} checked={selected[invoice.id] !== undefined} disabled={busy} onChange={(event) => choose([invoice], event.target.checked)} /></td><td>{invoice.invoiceNumber}</td><td>{invoice.supplierName}</td><td>{formatCurrency(invoice.total)}</td><td>{invoice.exceptionCount ? invoice.exceptionReason : "Clear"}</td></tr>)}</tbody></table></div>
        {approved.data.total === 0 && <div className="empty-state">No invoices are ready for export. Resolve exceptions and approve invoices in the review queue.</div>}
        <Pagination {...approved.data} onPage={setPage} disabled={busy || approved.loading} />
      </>}
      <div className="panel-padding"><div className="form-actions"><button className="button secondary" disabled={busy || count === 0} type="button" onClick={clearSelection}>Clear selection and reload</button><button className="button primary" type="button" disabled={busy || count === 0} onClick={() => void createBatch()}>{busy ? "Creating export..." : `Create CSV export (${count})`}</button></div><p className="help-text">No ERP or payment system is contacted. A lost connection can be retried safely with the same selection. For stale records, clear the selection and reload.</p></div>
    </section>
    <section className="panel spaced-panel"><div className="panel-header"><div><h2>Export history</h2><p>Immutable CSV batches shared with the team</p></div></div>
      <ErrorMessage error={batches.error} onRetry={batches.reload} />
      {batches.loading && !batches.data && <Loading />}
      {batches.data && <><div className="table-wrap"><table><thead><tr><th>Created</th><th>Created by</th><th>Invoices</th><th>Batch</th><th>Download</th></tr></thead><tbody>{batches.data.items.map((batch) => <tr key={batch.id}><td>{new Date(batch.createdAt).toLocaleString()}</td><td>{batch.createdBy}</td><td>{batch.invoiceCount}</td><td><code>{batch.id}</code></td><td><DownloadButton path={`/exports/${batch.id}/download`} filename={`invoices-${batch.id}.csv`} label="Download CSV" /></td></tr>)}</tbody></table></div>{batches.data.total === 0 && <p className="empty-state">No export batches yet.</p>}<Pagination {...batches.data} onPage={setBatchPage} disabled={batches.loading} /></>}
    </section>
  </div>;
}
