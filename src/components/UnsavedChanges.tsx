import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

export function UnsavedChanges({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker(dirty);
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (blocker.state === "blocked") stay.current?.focus();
  }, [blocker.state]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  if (blocker.state !== "blocked") return null;
  return <aside className="unsaved-prompt" role="alert"><strong>You have unsaved changes.</strong><p>Save the draft or explicitly discard your changes before leaving.</p><div className="form-actions"><button className="button primary" type="button" ref={stay} onClick={() => blocker.reset()}>Keep editing</button><button className="button secondary" type="button" onClick={() => blocker.proceed()}>Discard changes and leave</button></div></aside>;
}
