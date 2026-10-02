import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Page } from "../App";
import { useAppState } from "../state/appState";
import { ErrorMessage } from "./Feedback";

const navItems = [
  { id: "dashboard", label: "Overview", icon: "OV" },
  { id: "queue", label: "Invoice queue", icon: "IQ" },
  { id: "upload", label: "New invoice", icon: "IN" },
  { id: "exports", label: "Exports", icon: "EX" },
  { id: "reference", label: "Reference data", icon: "RD", admin: true },
  { id: "users", label: "Team access", icon: "TM", admin: true },
] satisfies Array<{ id: Page; label: string; icon: string; admin?: boolean }>;

export function Layout({ page, onNavigate, children }: { page: Page; onNavigate: (page: Page) => void; children: ReactNode }) {
  const { user, logout, refresh } = useAppState();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const main = useRef<HTMLElement>(null);
  const currentPage = typeof page === "object" ? "queue" : page;
  const pageKey = typeof page === "object" ? page.invoiceId : page;
  useEffect(() => { main.current?.focus(); }, [pageKey]);
  const items = navItems.filter((item) => !("admin" in item && item.admin) || user?.role === "admin");
  const signOut = async () => {
    setBusy(true); setError(null);
    try { await logout(); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to content</a>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">IE</span><div><strong>Invoice Exception</strong><span>Assistant</span></div></div>
      <nav className="nav" aria-label="Primary navigation">{items.map((item) => <button key={item.id} className={currentPage === item.id ? "nav-item active" : "nav-item"} aria-current={currentPage === item.id ? "page" : undefined} onClick={() => onNavigate(item.id)} type="button"><span className="nav-icon" aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav>
      <div className="sidebar-footer"><span className="demo-dot" aria-hidden="true" /><div><strong>Shared workspace</strong><small>Server-validated workflows</small></div></div>
    </aside>
    <div className="main-column">
      <header className="topbar">
        <button className="mobile-brand" onClick={() => onNavigate("dashboard")} type="button"><span className="brand-mark">IE</span><strong>Invoice Assistant</strong></button>
        <div className="topbar-context">
          <button type="button" className="text-button" onClick={refresh}>Refresh</button>
          <button type="button" className="profile-button" onClick={() => onNavigate("account")} aria-label="Your account"><span className="user-avatar" aria-hidden="true">{user?.name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span><span className="user-meta"><strong>{user?.name}</strong><span>{user?.role === "admin" ? "Administrator" : "AP reviewer"}</span></span></button>
          <button type="button" className="button secondary" disabled={busy} onClick={() => void signOut()}>{busy ? "Signing out..." : "Sign out"}</button>
        </div>
      </header>
      <ErrorMessage error={error} />
      <main className="main-content" id="main-content" ref={main} tabIndex={-1}>{children}</main>
      <nav className="mobile-nav" aria-label="Mobile navigation">{items.map((item) => <button key={item.id} className={currentPage === item.id ? "active" : ""} aria-current={currentPage === item.id ? "page" : undefined} onClick={() => onNavigate(item.id)} type="button"><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav>
    </div>
  </div>;
}
