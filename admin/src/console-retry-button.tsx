import { createContext, useContext } from "react";

export const ConsoleRetryContext = createContext<{
  busy: boolean;
  pending: boolean;
  retry: () => Promise<void>;
} | null>(null);

export function ConsoleRetryButton({ label, pendingLabel = label }: { label: string; pendingLabel?: string }) {
  const state = useContext(ConsoleRetryContext);
  if (!state) throw new Error("ConsoleRetryButton must be used inside ConsoleControllerProvider");
  const { busy, pending, retry } = state;
  const unavailable = busy || pending;
  // Native disabled buttons drop keyboard focus. Keep the trigger in place while
  // the console's shared refresh is pending, without accepting another activation.
  return <button type="button" className="buttonSecondary consoleRetry" aria-disabled={unavailable} aria-busy={pending}
    onClick={() => { if (!unavailable) void retry(); }}>{pending ? pendingLabel : label}</button>;
}
