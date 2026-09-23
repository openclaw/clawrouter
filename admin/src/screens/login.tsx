import React from "react";
import { LogIn, Route } from "lucide-react";
import { InlineError } from "../components";
import { localLogin } from "../ui-helpers";

export function LoginScreen({ gatewayOrigin, local, checking, message, onSuccess, onRetry }: { gatewayOrigin: string; local: boolean; checking: boolean; message: string; onSuccess: () => Promise<void>; onRetry: () => Promise<void> }) {
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const failure = await localLogin(gatewayOrigin, token.trim());
      if (failure) setError(failure);
      else { setToken(""); await onSuccess(); }
    } catch {
      setError("sign-in request failed; gateway unreachable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="loginShell">
      <form className="loginCard" onSubmit={submit}>
        <div className="brandBlock">
          <span className="brandMark"><Route aria-hidden="true" /></span>
          <div>
            <strong>ClawRouter</strong>
            <span>access gateway</span>
          </div>
        </div>
        <h1>{checking ? "Checking access" : "Sign in"}</h1>
        <p>{local ? "This self-hosted console uses local sign-in. Paste the admin token configured for this deployment." : "Reload the console to sign in, or retry after restoring your session."}</p>
        {message ? <InlineError message={message} /> : null}
        {error ? <InlineError message={error} /> : null}
        {local ? <><label>
          <span>admin token</span>
          <input type="password" autoComplete="current-password" autoFocus value={token} onChange={(event) => setToken(event.target.value)} />
        </label>
        <button type="submit" disabled={busy || checking || !token.trim()}>
          <LogIn className="buttonIcon" aria-hidden="true" />
          <span>Sign in</span>
        </button></> : <button type="button" disabled={checking} onClick={() => window.location.reload()}>Reload to sign in</button>}
        <button type="button" className="buttonSecondary" disabled={busy || checking} onClick={() => void onRetry()}>Retry access</button>
      </form>
    </main>
  );
}
