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
  const [status, setStatus] = useState(allowDemo ? "local demo data loaded" : "connected");
  const [refreshing, setRefreshing] = useState(!allowDemo);
  const [refreshError, setRefreshError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(allowDemo ? Date.now() : null);
  const [demoMode, setDemoMode] = useState(allowDemo);
  const [loginRequired, setLoginRequired] = useState(false);
  const statusPresentation = useMemo(() => consoleStatusPresentation(status, demoMode, false, refreshing), [demoMode, status, refreshing]);
  const busy = statusPresentation.tone === "pending";

  function navigateTo(nextView: View, replace = false) {
    setView(nextView);
    const nextPath = viewPaths[nextView];
    if (window.location.pathname === nextPath) return;
    const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
    if (replace) window.history.replaceState(null, "", nextUrl);
    else window.history.pushState(null, "", nextUrl);
    window.scrollTo(0, 0);
  }

  function enforceRoleView() {
    if (!refreshing && value.role !== "admin" && adminViews.has(view)) navigateTo("catalog", true);
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
    refreshing,
    setRefreshing,
    refreshError,
    setRefreshError,
    lastUpdatedAt,
    setLastUpdatedAt,
    demoMode,
    setDemoMode,
    loginRequired,
    setLoginRequired,
    busy,
    navigateTo,
    enforceRoleView,
    syncViewFromPath,
  };
}
