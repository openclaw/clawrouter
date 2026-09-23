import { useState } from "react";
import { InlineError, InlineNote } from "./components";
import type { CredentialOperations } from "./hooks/use-credential-operations";

export type CredentialFeedback = ReturnType<CredentialOperations["forSurface"]>;

export function CredentialNotice({ state }: { state: CredentialFeedback }) {
  return <>
    {state.error ? <><InlineError message={state.error} /><button type="button" className="buttonSecondary" onClick={() => void state.refresh()}>Refresh keys</button></> : null}
    {state.notice ? <InlineNote>{state.notice}</InlineNote> : null}
    {state.reveal ? <IssuedCredential key={state.reveal.key} value={state.reveal.key} onDismiss={state.dismiss} /> : state.busy ? <button type="button" className="buttonSecondary" onClick={state.dismiss}>Dismiss pending secret</button> : null}
  </>;
}

function IssuedCredential({ value, onDismiss }: { value: string; onDismiss: () => void }) {
  const [copyStatus, setCopyStatus] = useState("");
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed. Select and copy the key manually before dismissing it.");
    }
  }
  return <div className="issuedKey"><div><span>copy now · shown once · stored nowhere else</span><code>{value}</code>{copyStatus ? <span role="status">{copyStatus}</span> : null}</div><div><button type="button" className="buttonSecondary" onClick={() => void copy()}>Copy</button><button type="button" className="buttonSecondary" onClick={onDismiss}>Dismiss</button></div></div>;
}
