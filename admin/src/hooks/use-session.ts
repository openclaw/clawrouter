import { useMemo, useState } from "react";
import { consoleStatusPresentation } from "../status-display";
import { adminViews, demo, emptySession, initialViewFromPath, viewPaths } from "../ui-config";
import { isLocalDemoAllowed } from "../ui-helpers";
import type { SessionResponse, View } from "../ui-types";

export function useSession() {
  const gatewayOrigin = window.location.origin;
  const allowDemo = isLocalDemoAllowed();
  const [view, setView] = useState<View>(initialViewFromPath);
  const [value, setValue] = useState<SessionResponse>(allowDemo ? demo.session : emptySession);
  const [status, setStatus] = useState(allowDemo ? "local demo data loaded" : "loading");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(allowDemo ? Date.now() : null);
  const [demoMode, setDemoMode] = useState(allowDemo);
  const statusPresentation = useMemo(() => consoleStatusPresentation(status, demoMode), [demoMode, status]);
  const busy = statusPresentation.tone === "pending";

  function navigateTo(nextView: View, replace = false) {
    setView(nextView);
    const nextPath = viewPaths[nextView];
    if (window.location.pathname === nextPath) return;
    const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
    if (replace) window.history.replaceState(null, "", nextUrl);
    else window.history.pushState(null, "", nextUrl);
  }

  function enforceRoleView() {
    if (status !== "loading" && value.role !== "admin" && adminViews.has(view)) navigateTo("catalog", true);
  }

  function syncViewFromPath() {
    setView(initialViewFromPath());
  }

  return {
    gatewayOrigin,
    allowDemo,
    view,
    setView,
    value,
    setValue,
    status,
    setStatus,
    lastUpdatedAt,
    setLastUpdatedAt,
    demoMode,
    setDemoMode,
    statusPresentation,
    statusTone: statusPresentation.tone,
    busy,
    navigateTo,
    enforceRoleView,
    syncViewFromPath,
  };
}
