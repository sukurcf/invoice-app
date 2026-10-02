import { useState } from "react";
import type { Page } from "../App";
import type { InvoiceDetail, PageResult } from "../domain/api";
import type { Invoice, ReviewDecision, ReviewHistory } from "../domain/types";
import { formatCurrency, invoiceSubtotal, invoiceTotal } from "../domain/money";
import { editableStatuses, invoiceToInput } from "../domain/validation";
import { StatusPill } from "../components/StatusPill";
import { DownloadButton, ErrorMessage, Loading, Pagination } from "../components/Feedback";
import { InvoiceForm } from "../components/InvoiceForm";
import { useAppState, useResource } from "../state/appState";

const actionLabels: Record<ReviewDecision, string> = {
  approved: "Approve for export", correction_requested: "Request correction", escalated: "Escalate",
  reopened: "Reopen invoice", voided: "Void invoice",
};

export function InvoiceReview({ invoiceId, onNavigate }: { invoiceId: string; onNavigate: (page: Page) => void }) {
  const { user, request, refresh } = useAppState();
  const resource = useResource<InvoiceDetail>(`/invoices/${encodeURIComponent(invoiceId)}`);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const olderHistory = useResource<PageResult<ReviewHistory>>(historyPage > 1 ? `/invoices/${encodeURIComponent(invoiceId)}/history?page=${historyPage}` : null);
  const detail = resource.data;
  if (!detail) return <div><button className="back-button" type="button" onClick={() => onNavigate("queue")}>Back to invoice queue</button><ErrorMessage error={resource.error} onRetry={resource.reload} />{resource.loading && <Loading label="Loading invoice..." />}</div>;
  const { invoice, supplier, purchaseOrder, delivery, exceptions } = detail;
  const editable = editableStatuses.includes(invoice.status);
  const history = historyPage === 1 ? detail.history : olderHistory.data;
  const takeAction = async (action: ReviewDecision) => {
    setBusy(true); setError(null); setNotice("");
    try {
      await request(`/invoices/${invoice.id}/review`, { method: "POST", body: { action, version: invoice.version, note: reason.trim() } });
      setNotice(`${actionLabels[action]} saved to the audit history. No external system was contacted.`);
      setReason(""); setHistoryPage(1); refresh();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <div>
    <button className="back-button" onClick={() => onNavigate("queue")} type="button">&lt;- Back to invoice queue</button>
    <section className="review-heading"><div><div className="heading-status"><span className="eyebrow">Invoice review - version {invoice.version}</span><StatusPill status={invoice.status} /></div><h1>{invoice.invoiceNumber || "Unnumbered draft"}</h1><p>{supplier?.name ?? "Supplier not assigned"} / {formatCurrency(invoiceTotal(invoice.lineItems, invoice.tax))}</p></div>
      {editable && !editing && <button className="button secondary" type="button" onClick={() => { setEditing(invoice); setNotice(""); }}>Edit invoice</button>}
    </section>
    <ErrorMessage error={resource.error} onRetry={resource.reload} />
    <ErrorMessage error={error} />
    {notice && <div className="notice" role="status">{notice}</div>}
    {editing && <section className="panel editor-panel"><div className="panel-header"><div><h2>Edit and verify fields</h2><p>Editing version {editing.version}. Conflicting changes will be rejected, never overwritten.</p></div></div><InvoiceForm initial={invoiceToInput(editing)} editing labels={{ supplier: supplier?.name, order: purchaseOrder?.poNumber, delivery: delivery?.deliveryNumber }} onCancel={() => setEditing(null)} onSave={async (input, note) => {
      await request(`/invoices/${editing.id}`, { method: "PUT", body: { invoice: input, version: editing.version, note } });
      setEditing(null); setNotice("Invoice fields and verification history saved."); setHistoryPage(1); refresh();
    }} /><button type="button" className="text-button panel-padding" onClick={() => { setEditing(null); resource.reload(); }}>Discard edits and reload latest version</button></section>}
    {!editing && (editable || (invoice.status === "ready_to_export" && user?.role === "admin")) && <section className="panel decision-panel">
      <label>Review note<textarea maxLength={1000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} placeholder="Required for correction, escalation, void, or reopen. Approval notes are optional." /></label>
      <div className="review-actions">
        {editable && <><button className="button secondary" disabled={busy || !reason.trim()} onClick={() => void takeAction("correction_requested")} type="button">Request correction</button><button className="button secondary" disabled={busy || !reason.trim()} onClick={() => void takeAction("escalated")} type="button">Escalate</button><button className="button secondary danger-outline" disabled={busy || !reason.trim()} onClick={() => void takeAction("voided")} type="button">Void invoice</button><button className="button primary" disabled={busy || resource.loading || exceptions.length > 0} onClick={() => void takeAction("approved")} type="button">{busy ? "Saving decision..." : "Approve for export"}</button></>}
        {invoice.status === "ready_to_export" && user?.role === "admin" && <button className="button secondary" disabled={busy || !reason.trim()} onClick={() => void takeAction("reopened")} type="button">Reopen invoice</button>}
      </div>
      {exceptions.length > 0 && <p className="help-text">Approval is blocked until every exception is resolved. There is no override.</p>}
    </section>}
    {(invoice.status === "exported" || invoice.status === "voided") && <div className="notice">This {invoice.status} record is locked. Its saved versions remain available in the audit history.</div>}
    <div className="review-layout">
      <div className="review-main">
        {exceptions.length > 0 ? <section className="panel exceptions-panel"><div className="panel-header"><div><h2>Exceptions found</h2><p>Current server-side rules and source evidence</p></div><span className="count-badge">{exceptions.length}</span></div><div className="exception-list">{exceptions.map((exception) => <article className={`exception-card severity-${exception.severity}`} key={exception.id}><div className="exception-symbol" aria-hidden="true">!</div><div><div className="exception-title"><h3>{exception.title}</h3><span>{exception.severity}</span></div><p>{exception.explanation}</p><dl className="evidence-values">{exception.sourceValues.map((source) => <div key={source.label}><dt>{source.label}</dt><dd>{source.value}</dd></div>)}</dl>{exception.calculation && <code>{exception.calculation}</code>}</div></article>)}</div></section>
          : invoice.status !== "voided" && <section className="match-banner"><span aria-hidden="true">OK</span><div><strong>No exceptions found</strong><p>Required fields and three-way matching pass current server checks.</p></div></section>}
        <section className="panel"><div className="panel-header"><div><h2>Three-way comparison</h2><p>Invoice vs. purchase order vs. goods received</p></div><span className="rule-chip">5% PRICE TOLERANCE</span></div>
          <div className="table-wrap comparison-table"><table><thead><tr><th>Item</th><th>Invoice qty</th><th>PO qty</th><th>Received</th><th>Invoice price</th><th>PO price</th><th>Result</th></tr></thead><tbody>{invoice.lineItems.map((line) => {
            const poLine = purchaseOrder?.lineItems.find((item) => item.sku === line.sku);
            const deliveryLine = delivery?.lineItems.find((item) => item.sku === line.sku);
            const hasIssue = !poLine || !deliveryLine || exceptions.some((exception) => exception.id.endsWith(line.id));
            return <tr key={line.id}><td><strong>{line.description}</strong><small>{line.sku}</small></td><td>{line.quantity}</td><td>{poLine?.quantity ?? "-"}</td><td>{deliveryLine?.quantity ?? "-"}</td><td>{formatCurrency(line.unitPrice)}</td><td>{poLine ? formatCurrency(poLine.unitPrice) : "-"}</td><td><span className={hasIssue ? "comparison-result issue" : "comparison-result match"}>{hasIssue ? "Check" : "Match"}</span></td></tr>;
          })}</tbody></table></div>
          {invoice.lineItems.length === 0 && <p className="empty-state">Edit this draft to add invoice line items.</p>}
        </section>
        <section className="panel source-grid-panel">
          <div className="source-card"><span className="source-label">INVOICE</span><h3>{invoice.invoiceNumber || "Draft"}</h3><dl><div><dt>Invoice date</dt><dd>{invoice.date || "-"}</dd></div><div><dt>Due date</dt><dd>{invoice.dueDate || "-"}</dd></div><div><dt>Subtotal</dt><dd>{formatCurrency(invoiceSubtotal(invoice.lineItems))}</dd></div><div><dt>Tax</dt><dd>{formatCurrency(invoice.tax)}</dd></div><div className="total-row"><dt>Total</dt><dd>{formatCurrency(invoiceTotal(invoice.lineItems, invoice.tax))}</dd></div></dl></div>
          <div className="source-card"><span className="source-label">PURCHASE ORDER</span><h3>{purchaseOrder?.poNumber ?? "Not linked"}</h3><dl><div><dt>Ordered</dt><dd>{purchaseOrder?.orderedDate ?? "-"}</dd></div><div><dt>Lines</dt><dd>{purchaseOrder?.lineItems.length ?? 0}</dd></div><div className="total-row"><dt>Ordered value</dt><dd>{purchaseOrder ? formatCurrency(invoiceSubtotal(purchaseOrder.lineItems)) : "-"}</dd></div></dl></div>
          <div className="source-card"><span className="source-label">DELIVERY RECORD</span><h3>{delivery?.deliveryNumber ?? "Not linked"}</h3><dl><div><dt>Received</dt><dd>{delivery?.receivedDate ?? "-"}</dd></div><div><dt>PO reference</dt><dd>{purchaseOrder?.poNumber ?? "-"}</dd></div><div className="total-row"><dt>Units received</dt><dd>{delivery?.lineItems.reduce((sum, line) => sum + line.quantity, 0) ?? 0}</dd></div></dl></div>
        </section>
      </div>
      <aside className="review-sidebar">
        <section className="panel"><div className="panel-header"><div><h2>Invoice source</h2><p>Authenticated document access</p></div></div><div className="panel-padding">{invoice.sourceFile ? <><p className="filename">{invoice.sourceFile.name}</p><DownloadButton path={`/invoices/${invoice.id}/document`} filename={invoice.sourceFile.name} label="Download source document" /></> : <p>No source file attached. This invoice was entered manually or loaded as a synthetic example.</p>}</div></section>
        <section className="panel fields-panel"><div className="panel-header"><div><h2>Field provenance</h2><p>Manual verification or synthetic example extraction</p></div></div><dl>{invoice.extractedFields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value || "Missing"}{field.confidence !== undefined ? <span className={field.confidence < 0.8 ? "confidence low" : "confidence"}>{Math.round(field.confidence * 100)}%</span> : <small>Manual entry</small>}</dd></div>)}</dl></section>
        <section className="panel"><div className="panel-header"><div><h2>Review history</h2><p>Append-only events and saved invoice versions</p></div></div>
          <ErrorMessage error={olderHistory.error} onRetry={olderHistory.reload} />
          {olderHistory.loading && <Loading label="Loading history..." />}
          {history && <><ol className="history-list">{history.items.map((item) => <li key={item.id}><span className={`activity-marker activity-${item.action}`} /><div><strong>{item.detail}</strong><span>{item.user}</span><time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleString()}</time>{item.snapshot && <details><summary>View saved version {item.version}</summary><pre className="audit-snapshot">{JSON.stringify(item.snapshot, null, 2)}</pre></details>}</div></li>)}</ol><Pagination {...history} onPage={setHistoryPage} disabled={olderHistory.loading} /></>}
        </section>
      </aside>
    </div>
  </div>;
}
