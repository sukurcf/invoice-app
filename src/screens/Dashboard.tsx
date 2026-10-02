import type { Page } from "../App";
import type { DashboardData } from "../domain/api";
import { formatCurrency } from "../domain/money";
import { useAppState, useResource } from "../state/appState";
import { StatusPill } from "../components/StatusPill";
import { ErrorMessage, Loading } from "../components/Feedback";

export function Dashboard({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const { user } = useAppState();
  const resource = useResource<DashboardData>("/dashboard");
  const data = resource.data;
  if (!data) return <><ErrorMessage error={resource.error} onRetry={resource.reload} />{resource.loading && <Loading label="Loading your workspace..." />}</>;
  const awaiting = data.counts.needs_review + data.counts.possible_duplicate + data.counts.correction_requested + data.counts.escalated;
  const cards = [
    { label: "Needs attention", value: awaiting, detail: "Unresolved review work", tone: "amber" },
    { label: "Matched", value: data.counts.matched, detail: "Awaiting human approval", tone: "green" },
    { label: "Ready for export", value: data.counts.ready_to_export, detail: "Approved by your team", tone: "blue" },
    { label: "Exported", value: data.counts.exported, detail: "Retained CSV batches", tone: "green" },
  ];
  return <div>
    <section className="page-heading split-heading"><div><span className="eyebrow">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</span><h1>Welcome, {user?.name.split(" ")[0]}</h1><p>Your shared invoice workspace. All decisions are validated and recorded on the server.</p></div><button className="button primary" onClick={() => onNavigate("upload")} type="button">+ New invoice</button></section>
    <ErrorMessage error={resource.error} onRetry={resource.reload} />
    <section className="metrics-grid" aria-label="Invoice summary">{cards.map((card) => <article className={`metric-card metric-${card.tone}`} key={card.label}><div className="metric-icon" aria-hidden="true">{card.value}</div><div><span>{card.label}</span><strong>{card.value}</strong><small>{card.detail}</small></div></article>)}</section>
    <div className="dashboard-grid">
      <section className="panel"><div className="panel-header"><div><h2>Priority review</h2><p>Oldest invoices needing attention</p></div><button className="text-button" onClick={() => onNavigate("queue")} type="button">View queue</button></div>
        {data.priority.length === 0 ? <div className="empty-state"><strong>No outstanding exceptions</strong><p>Create an invoice or open the queue to review matched drafts.</p></div> : data.priority.map((invoice) => <button className="priority-row" key={invoice.id} onClick={() => onNavigate({ name: "review", invoiceId: invoice.id })} type="button"><span className="document-icon" aria-hidden="true">INV</span><span className="priority-main"><strong>{invoice.invoiceNumber || "Unnumbered draft"}</strong><small>{invoice.supplierName}</small></span><span className="priority-amount">{formatCurrency(invoice.total)}</span><StatusPill status={invoice.status} /><span className="chevron" aria-hidden="true">&gt;</span></button>)}
      </section>
      <section className="panel activity-panel"><div className="panel-header"><div><h2>Recent activity</h2><p>Persisted review events</p></div></div>
        {data.history.length === 0 ? <div className="empty-state">No review activity yet.</div> : <ol className="activity-list">{data.history.map((history) => <li key={history.id}><span className={`activity-marker activity-${history.action}`} /><div><strong>{history.detail}</strong><span>{history.invoiceNumber || "Draft"} - {history.user}</span><time dateTime={history.timestamp}>{new Date(history.timestamp).toLocaleString()}</time></div></li>)}</ol>}
      </section>
    </div>
    <section className="export-banner"><div><span className="export-icon" aria-hidden="true">CSV</span><div><strong>{data.counts.ready_to_export} invoices ready for export</strong><p>Create a retained CSV batch. No ERP or payment system is connected.</p></div></div><button className="button secondary" onClick={() => onNavigate("exports")} type="button">Manage exports</button></section>
    {user?.role === "admin" && Object.values(data.counts).every((count) => count === 0) && <section className="info-card onboarding"><div><h2>Set up your workspace</h2><p>Create suppliers, purchase orders and goods receipts, then add your reviewers and enter invoices.</p><button className="text-button" onClick={() => onNavigate("reference")} type="button">Add reference data</button><button className="text-button" onClick={() => onNavigate("users")} type="button">Manage team access</button></div></section>}
  </div>;
}
