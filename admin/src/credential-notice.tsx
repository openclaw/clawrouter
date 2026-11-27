import { useId, useState } from "react";
import { InlineError, InlineNote } from "./components";
import type { CredentialOperations } from "./hooks/use-credential-operations";

export type CredentialFeedback = ReturnType<CredentialOperations["forSurface"]>;

export function CredentialNotice({ state }: { state: CredentialFeedback }) {
  return <>
    {state.error ? <><InlineError message={state.error} /><button type="button" className="buttonSecondary" onClick={() => void state.refresh()}>Refresh keys</button></> : null}
    {state.notice ? <InlineNote>{state.notice}</InlineNote> : null}
    {state.busy ? <div className="inlineNote" role="status">{state.pendingReveal === "dismissed"
      ? "The one-time secret won’t be shown. Key actions are unavailable until this change finishes."
      : "A credential change is still finishing. Key actions are temporarily unavailable."}</div> : null}
    {state.reveal ? <IssuedCredential key={state.reveal.key} reveal={state.reveal} onDismiss={state.dismiss} /> : state.pendingReveal === "available" ? <button type="button" className="buttonSecondary" onClick={state.dismiss}>Dismiss pending secret</button> : null}
  </>;
}

function IssuedCredential({ reveal, onDismiss }: { reveal: NonNullable<CredentialFeedback["reveal"]>; onDismiss: () => void }) {
  const statusId = useId();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual" | "focus-manual">("idle");
  async function copy(button: HTMLButtonElement) {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(reveal.key);
      setCopyState("copied");
    } catch {
      // A delayed permission prompt must not take focus back from another control.
      setCopyState(document.activeElement === button ? "focus-manual" : "manual");
    }
  }
  const manual = copyState === "manual" || copyState === "focus-manual";
  return <div className="issuedKey"><div>
    <span>copy now · shown once · stored nowhere else</span><span>{reveal.credentialId} · {reveal.policyId}</span>
    {manual
      ? <input aria-label="One-time key" aria-describedby={statusId} readOnly autoFocus={copyState === "focus-manual"} value={reveal.key} onFocus={(event) => event.currentTarget.select()} />
      : <code>{reveal.key}</code>}
    {copyState !== "idle" ? <span id={statusId} role="status">{manual ? "Automatic copy unavailable. Use your device’s Copy command before dismissing the key." : "Copied"}</span> : null}
  </div><div>
    {!manual ? <button type="button" className="buttonSecondary" onClick={(event) => void copy(event.currentTarget)}>Copy</button> : null}
    <button type="button" className="buttonSecondary" onClick={onDismiss}>Dismiss</button>
  </div></div>;
}
