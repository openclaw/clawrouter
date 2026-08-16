import React from "react";
import { LogIn, Route } from "lucide-react";
import { InlineError } from "../components";
import { localLogin } from "../ui-helpers";

export function LoginScreen({ gatewayOrigin, onSuccess }: { gatewayOrigin: string; onSuccess: () => void }) {
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
      else onSuccess();
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
        <h1>Sign in</h1>
        <p>This self-hosted console uses local sign-in. Paste the admin token configured for this deployment.</p>
        {error ? <InlineError message={error} /> : null}
        <label>
          <span>admin token</span>
          <input type="password" autoComplete="current-password" autoFocus value={token} onChange={(event) => setToken(event.target.value)} />
        </label>
        <button type="submit" disabled={busy || !token.trim()}>
          <LogIn className="buttonIcon" aria-hidden="true" />
          <span>Sign in</span>
        </button>
      </form>
    </main>
  );
}
