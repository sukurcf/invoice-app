import { useState, type FormEvent } from "react";
import { ErrorMessage } from "../components/Feedback";
import { useAppState } from "../state/appState";

export function Login() {
  const { login } = useAppState();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try { await login(email.trim(), password); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <main className="auth-shell"><section className="panel auth-card">
    <span className="brand-mark" aria-hidden="true">IE</span><span className="eyebrow">Invoice Exception Assistant</span>
    <h1>Sign in to your workspace</h1><p>Review invoices, resolve exceptions, and prepare controlled exports with your finance team.</p>
    <form onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy} className="form-stack">
        <label>Email<input autoComplete="username" type="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label>Password<input autoComplete="current-password" type="password" maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <button className="button primary" type="submit">{busy ? "Signing in..." : "Sign in"}</button>
      </fieldset>
      <ErrorMessage error={error} />
    </form>
    <p className="help-text">Accounts are created by your administrator. Contact them for access or a password reset. There is no public registration.</p>
  </section></main>;
}
