import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { consoleStatusPresentation } from "../status-display";
import { adminViews, emptySession, initialViewFromPath, viewPaths } from "../ui-config";
import { isLocalDemoAllowed } from "../ui-helpers";
import { sessionScopeKey, type CapturedSessionScope, type SessionScope } from "../session-scope";
import type { SessionResponse, View } from "../ui-types";

export function useSession() {
  const gatewayOrigin = window.location.origin;
  const allowDemo = isLocalDemoAllowed();
  const [view, setView] = useState<View>(initialViewFromPath);
  const [value, setValue] = useState<SessionResponse>(emptySession);
  const [status, setStatusValue] = useState("connecting");
  const statusRevision = useRef(0);
  const setStatus = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    // Admission, including same-text writes, retires older refresh publications before React renders.
    statusRevision.current += 1;
    setStatusValue(next);
  }, []);
  const [refreshing, setRefreshing] = useState(true);
  const [refreshError, setRefreshError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [scopeEpoch, setScopeEpoch] = useState(0);
  const scopeRef = useRef<SessionScope>({ origin: gatewayOrigin, demo: false, session: emptySession, epoch: 0 });
  // History gets opaque keys, not service or account details. One key per launched service per scope.
  const catalogFocus = useRef({ epoch: -1, byService: new Map<string, string>() });
  const statusPresentation = useMemo(() => consoleStatusPresentation(status, demoMode, false, refreshing), [demoMode, status, refreshing]);
  const busy = statusPresentation.tone === "pending";

  function captureScope(): CapturedSessionScope {
    const scope = scopeRef.current;
    return { ...scope, isCurrent: () => scopeRef.current.epoch === scope.epoch };
  }

  function captureStatusPublisher(): Dispatch<SetStateAction<string>> {
    const revision = statusRevision.current;
    const scope = captureScope();
    return (next) => {
      if (scope.isCurrent() && statusRevision.current === revision) setStatus(next);
    };
  }

  function accept(next: SessionResponse, demo: boolean): boolean {
    const previous = scopeRef.current;
    const changed = sessionScopeKey(previous) !== sessionScopeKey({ origin: gatewayOrigin, demo, session: next });
    scopeRef.current = { origin: gatewayOrigin, demo, session: next, epoch: previous.epoch + Number(changed) };
    setValue(next);
    setDemoMode(demo);
    if (changed) {
      setScopeEpoch(scopeRef.current.epoch);
      setRefreshing(!demo);
      setStatus(demo ? "local demo data loaded" : "connected");
      setRefreshError("");
      setLastUpdatedAt(null);
    }
    return changed;
  }

  function invalidate(scope: CapturedSessionScope): boolean {
    if (!scope.isCurrent()) return false;
    // Reauthentication of the same account is a new lifetime, including drafts.
    scopeRef.current = { origin: gatewayOrigin, demo: false, session: emptySession, epoch: scopeRef.current.epoch + 1 };
    setScopeEpoch(scopeRef.current.epoch);
    setValue(emptySession);
    setDemoMode(false);
    setStatus("sign-in required");
    setRefreshError("");
    setLastUpdatedAt(null);
    setRefreshing(false);
    return true;
  }

  function navigateTo(nextView: View, replace = false) {
    setView(nextView);
    const nextPath = viewPaths[nextView];
    if (window.location.pathname === nextPath) return;
    if (view === "catalog" && !replace) {
      const state = window.history.state ?? {};
      const button = document.activeElement;
      const service = nextView === "playground" && button instanceof HTMLButtonElement && button.matches(":focus-visible")
        ? button.dataset.catalogPlayService : undefined;
      if (service) {
        const epoch = scopeRef.current.epoch;
        if (catalogFocus.current.epoch !== epoch) catalogFocus.current = { epoch, byService: new Map() };
        const keys = catalogFocus.current.byService;
        const key = keys.get(service) ?? crypto.getRandomValues(new Uint32Array(4)).join("-");
        keys.set(service, key);
        window.history.replaceState({ ...state, catalogLaunchFocus: key }, "");
      } else if (state.catalogLaunchFocus) {
        // Leaving the same history entry a different way must not resurrect an earlier launch.
        const updated = { ...state };
        delete updated.catalogLaunchFocus;
        window.history.replaceState(updated, "");
      }
    }
    const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
    if (replace) window.history.replaceState(null, "", nextUrl);
    else window.history.pushState(null, "", nextUrl);
    window.scrollTo(0, 0);
  }

  function enforceRoleView() {
    if (!refreshing && value.role !== "admin" && adminViews.has(view)) navigateTo("catalog", true);
  }

  function syncViewFromPath() {
    const next = initialViewFromPath();
    const focused = document.activeElement;
    // Follow Back/Forward only if focus was tracking the departing page in the nav.
    const nav = focused?.matches('button[data-console-view][aria-current="page"]') ? focused.closest("nav") : null;
    const key = window.history.state?.catalogLaunchFocus;
    if (next === "catalog" && key && !nav && catalogFocus.current.epoch === scopeRef.current.epoch) {
      // This popstate listener runs outside React. Remount Catalog before looking up the action.
      flushSync(() => setView(next));
      const launch = document.querySelector<HTMLButtonElement>("button[data-catalog-play-service]:enabled");
      const service = launch?.dataset.catalogPlayService;
      if (document.activeElement === document.body && launch && service && catalogFocus.current.byService.get(service) === key) {
        launch.focus({ preventScroll: true });
      }
      return;
    }
    setView(next);
    const target = nav?.querySelector<HTMLButtonElement>(`button[data-console-view="${next}"]`);
    if (target && target !== focused) target.focus();
  }

  return {
    gatewayOrigin,
    allowDemo,
    view,
    setView,
    value,
    accept,
    invalidate,
    captureScope,
    scopeEpoch,
    status,
    setStatus,
    captureStatusPublisher,
    refreshing,
    setRefreshing,
    refreshError,
    setRefreshError,
    lastUpdatedAt,
    setLastUpdatedAt,
    demoMode,
    busy,
    navigateTo,
    enforceRoleView,
    syncViewFromPath,
  };
}
