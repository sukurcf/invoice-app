import { useState, type FormEvent } from "react";
import { ErrorMessage } from "../components/Feedback";
import { passwordSchema } from "../domain/validation";
import { useAppState } from "../state/appState";

export function Account({ required = false }: { required?: boolean }) {
  const { user, changePassword, logout } = useAppState();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice("");
    const valid = passwordSchema.safeParse(newPassword);
    if (!valid.success) { setError(valid.error.issues.map((issue) => issue.message).join(" ")); return; }
    if (newPassword !== confirmation) { setError("The new passwords do not match."); return; }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
      setNotice("Password changed. All other sessions have been signed out.");
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <section className={required ? "panel auth-card" : "panel account-card"}>
    <h1>{required ? "Change your temporary password" : "Your account"}</h1>
    <p>{user?.name} - {user?.email}</p><p>{required ? "Set a private password before accessing team data." : "Changing your password revokes all previous sessions."}</p>
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="form-stack" disabled={busy}>
        <label>Current password<input type="password" autoComplete="current-password" maxLength={128} required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
        <label>New password<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <p className="help-text">Use a unique passphrase of 12-128 characters.</p>
        <button className="button primary" type="submit">{busy ? "Saving..." : "Change password"}</button>
      </fieldset>
      <ErrorMessage error={error} />
      {notice && <p className="notice" role="status">{notice}</p>}
    </form>
    {required && <button className="text-button" type="button" disabled={busy} onClick={() => { void logout().catch(setError); }}>Sign out</button>}
  </section>;
}
