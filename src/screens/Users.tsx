import { useState, type FormEvent } from "react";
import type { AuditEvent, PageResult } from "../domain/api";
import type { User } from "../domain/types";
import { createUserSchema, resetPasswordSchema } from "../domain/validation";
import { useAppState, useResource } from "../state/appState";
import { ErrorMessage, Loading, Pagination } from "../components/Feedback";
import { UnsavedChanges } from "../components/UnsavedChanges";

function UserControls({ user }: { user: User }) {
  const { user: current, request, refresh } = useAppState();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const self = user.id === current?.id;
  const update = async (body: unknown) => {
    setBusy(true); setError(null); setNotice("");
    try { await request(`/admin/users/${user.id}`, { method: "PATCH", body }); setNotice("Account updated; sessions revoked."); refresh(); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  const reset = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null); setNotice("");
    try {
      const body = resetPasswordSchema.parse({ password });
      await request(`/admin/users/${user.id}/reset-password`, { method: "POST", body });
      setPassword(""); setNotice("Temporary password set. Share it securely; the user must change it at sign-in."); refresh();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <div className="user-controls">
    <label><span className="sr-only">Role for {user.email}</span><select value={user.role} disabled={self || busy} onChange={(event) => { void update({ active: user.active, role: event.target.value }); }}><option value="reviewer">Reviewer</option><option value="admin">Administrator</option></select></label>
    <button type="button" className="button secondary" disabled={self || busy} onClick={() => void update({ active: !user.active, role: user.role })}>{user.active ? "Disable account" : "Enable account"}</button>
    {!self && <details><summary>Set temporary password</summary><form className="form-stack" onSubmit={(event) => void reset(event)}><label>Temporary password for {user.email}<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label><button type="submit" className="button secondary" disabled={busy}>Reset password</button></form></details>}
    {self && <small>Your own access is managed by another administrator.</small>}
    <ErrorMessage error={error} />
    {notice && <small role="status">{notice}</small>}
  </div>;
}
export function Users() {
  const { request, refresh } = useAppState();
  const [page, setPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("reviewer");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const users = useResource<PageResult<User>>(`/admin/users?page=${page}`);
  const audit = useResource<PageResult<AuditEvent>>(`/admin/audit?page=${auditPage}`);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null); setNotice("");
    try {
      const body = createUserSchema.parse({ name, email, role, password });
      await request("/admin/users", { method: "POST", body });
      setName(""); setEmail(""); setPassword(""); setRole("reviewer");
      setNotice("Account created. Share the temporary password securely; no email was sent. The user must change it at first sign-in."); refresh();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <div>
    <section className="page-heading"><span className="eyebrow">Administration</span><h1>Team access</h1><p>Admin-created accounts for one shared finance team. Disabling or changing access revokes existing sessions.</p></section>
    <section className="panel"><div className="panel-header"><h2>Create an account</h2></div><form className="catalog-form panel-padding" onSubmit={(event) => void submit(event)}>
      <UnsavedChanges dirty={!busy && Boolean(name || email || password)} />
      <fieldset disabled={busy} className="form-grid"><label>Full name<input value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} /></label><label>Email<input type="email" value={email} maxLength={254} required onChange={(event) => setEmail(event.target.value)} /></label><label>Role<select value={role} onChange={(event) => setRole(event.target.value)}><option value="reviewer">Reviewer</option><option value="admin">Administrator</option></select></label><label>Temporary password<input type="password" autoComplete="new-password" value={password} minLength={12} maxLength={128} required onChange={(event) => setPassword(event.target.value)} /></label><div className="form-actions"><button className="button primary" type="submit">{busy ? "Creating..." : "Create account"}</button></div></fieldset>
      <ErrorMessage error={error} />{notice && <p className="notice" role="status">{notice}</p>}
    </form></section>
    <section className="panel spaced-panel"><div className="panel-header"><h2>Team members</h2></div><ErrorMessage error={users.error} onRetry={users.reload} />{users.loading && !users.data && <Loading />}
      {users.data && <><div className="table-wrap"><table><thead><tr><th>Member</th><th>Status</th><th>Access controls</th></tr></thead><tbody>{users.data.items.map((user) => <tr key={user.id}><td><strong>{user.name}</strong><small>{user.email}</small></td><td>{user.active ? "Active" : "Disabled"}{user.mustChangePassword && <small>Password change required</small>}</td><td><UserControls user={user} /></td></tr>)}</tbody></table></div><Pagination {...users.data} onPage={setPage} disabled={users.loading} /></>}
    </section>
    <section className="panel spaced-panel"><div className="panel-header"><div><h2>Administrative audit</h2><p>Account, reference-data and export events</p></div></div><ErrorMessage error={audit.error} onRetry={audit.reload} />{audit.loading && !audit.data && <Loading />}
      {audit.data && <><ol className="activity-list">{audit.data.items.map((event) => <li key={event.id}><span className="activity-marker" /><div><strong>{event.detail}</strong><span>{event.user} - {event.action.replaceAll("_", " ")}</span><time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleString()}</time></div></li>)}</ol>{audit.data.total === 0 && <p className="empty-state">No administrative events yet.</p>}<Pagination {...audit.data} onPage={setAuditPage} disabled={audit.loading} /></>}
    </section>
  </div>;
}
