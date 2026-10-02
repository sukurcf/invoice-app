import type { ReactNode } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ErrorMessage, Loading } from "./components/Feedback";
import { Dashboard } from "./screens/Dashboard";
import { InvoiceQueue } from "./screens/InvoiceQueue";
import { InvoiceReview } from "./screens/InvoiceReview";
import { Upload } from "./screens/Upload";
import { Login } from "./screens/Login";
import { Account } from "./screens/Account";
import { Exports } from "./screens/Exports";
import { ReferenceData } from "./screens/ReferenceData";
import { Users } from "./screens/Users";
import { useAppState } from "./state/appState";

export type Page = "dashboard" | "queue" | "upload" | "exports" | "reference" | "users" | "account" | { name: "review"; invoiceId: string };
const paths = { dashboard: "/", queue: "/invoices", upload: "/invoices/new", exports: "/exports", reference: "/reference-data", users: "/users", account: "/account" };
function ReviewRoute({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const { invoiceId } = useParams();
  return invoiceId ? <InvoiceReview key={invoiceId} invoiceId={invoiceId} onNavigate={onNavigate} /> : <h1>Invoice not found</h1>;
}
export default function App() {
  const { user, loading, authError, retrySession } = useAppState();
  const navigate = useNavigate();
  const location = useLocation();
  const onNavigate = (page: Page) => { void navigate(typeof page === "object" ? `/invoices/${encodeURIComponent(page.invoiceId)}` : paths[page]); };
  if (loading) return <main className="auth-shell"><Loading label="Checking your session..." /></main>;
  if (authError) return <main className="auth-shell"><section className="panel auth-card"><h1>Unable to load the workspace</h1><ErrorMessage error={authError} onRetry={retrySession} /></section></main>;
  if (!user) return <Login />;
  if (user.mustChangePassword) return <main className="auth-shell"><Account required /></main>;
  const page: Page = location.pathname === "/invoices/new" ? "upload" : location.pathname.startsWith("/invoices/") ? { name: "review", invoiceId: location.pathname.slice(10) }
    : location.pathname === "/invoices" ? "queue" : location.pathname === "/exports" ? "exports" : location.pathname === "/reference-data" ? "reference" : location.pathname === "/users" ? "users" : location.pathname === "/account" ? "account" : "dashboard";
  const adminOnly = (element: ReactNode) => user.role === "admin" ? element : <section className="empty-state" role="alert"><h1>Administrator access required</h1><p>Your reviewer account cannot administer this workspace.</p></section>;
  return <Layout page={page} onNavigate={onNavigate}><Routes>
    <Route path="/" element={<Dashboard onNavigate={onNavigate} />} />
    <Route path="/invoices" element={<InvoiceQueue onNavigate={onNavigate} />} />
    <Route path="/invoices/new" element={<Upload onNavigate={onNavigate} />} />
    <Route path="/invoices/:invoiceId" element={<ReviewRoute onNavigate={onNavigate} />} />
    <Route path="/exports" element={<Exports />} />
    <Route path="/reference-data" element={adminOnly(<ReferenceData />)} />
    <Route path="/users" element={adminOnly(<Users />)} />
    <Route path="/account" element={<Account />} />
    <Route path="*" element={<section className="empty-state"><h1>Page not found</h1><button className="button primary" type="button" onClick={() => onNavigate("dashboard")}>Return to overview</button></section>} />
  </Routes></Layout>;
}
