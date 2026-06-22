export const AUTO_REFRESH_INTERVAL_MS = 30_000;

type RefreshWindow = Pick<Window, "addEventListener" | "removeEventListener" | "setInterval" | "clearInterval">;
type RefreshDocument = Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;

export function installAutoRefresh(
  refresh: () => void,
  windowTarget: RefreshWindow = window,
  documentTarget: RefreshDocument = document,
) {
  const refreshWhenVisible = () => {
    if (documentTarget.visibilityState === "visible") refresh();
  };
  const interval = windowTarget.setInterval(refreshWhenVisible, AUTO_REFRESH_INTERVAL_MS);
  windowTarget.addEventListener("focus", refreshWhenVisible);
  documentTarget.addEventListener("visibilitychange", refreshWhenVisible);

  return () => {
    windowTarget.clearInterval(interval);
    windowTarget.removeEventListener("focus", refreshWhenVisible);
    documentTarget.removeEventListener("visibilitychange", refreshWhenVisible);
  };
}
