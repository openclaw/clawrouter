import { useConsole } from "./console-controller-context";

export function ConsoleRetryButton({ label, pendingLabel = label }: { label: string; pendingLabel?: string }) {
  const { session, retryRefresh, retryPending } = useConsole();
  const unavailable = session.busy || retryPending;
  // Native disabled buttons drop keyboard focus. Keep the trigger in place while
  // the console's shared refresh is pending, without accepting another activation.
  return <button type="button" className="buttonSecondary consoleRetry" aria-disabled={unavailable} aria-busy={retryPending}
    onClick={() => { if (!unavailable) void retryRefresh(); }}>{retryPending ? pendingLabel : label}</button>;
}
