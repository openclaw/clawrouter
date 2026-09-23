import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { authenticationRequired, request, type ConsoleRequest } from "./dashboard-fetch";
import { errorMessage } from "./domain";
import { useCredentialOperations, type CredentialOperations } from "./hooks/use-credential-operations";
import { useSession } from "./hooks/use-session";
import { LoginScreen } from "./screens/login";
import { browserSession, type CapturedSessionScope } from "./session-scope";
import { demo } from "./ui-config";
import { localDemoRole } from "./ui-helpers";
import type { SessionResponse } from "./ui-types";
import { type ConsoleController, useConsoleController } from "./use-console-controller";

const ConsoleControllerContext = createContext<ConsoleController | null>(null);

export function ConsoleControllerProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [checking, setChecking] = useState(true);
  const [localLogin, setLocalLogin] = useState<boolean | null>(null);
  const [authenticationError, setAuthenticationError] = useState("");
  const probeGeneration = useRef(0);
  const pendingProbe = useRef<Promise<SessionResponse | null> | null>(null);
  const started = useRef(false);
  const credentialRefresh = useRef<(ownsScope: () => boolean) => Promise<void>>(async () => undefined);
  const credentialOwner = useCredentialOperations(session.captureScope, requestForScope, session.setStatus, (ownsScope) => credentialRefresh.current(ownsScope));

  function accept(value: SessionResponse, demoMode = false) {
    if (session.accept(value, demoMode)) credentialOwner.clearScope();
    setAuthenticationError("");
    setChecking(false);
  }

  function invalidate(scope: CapturedSessionScope) {
    if (!session.invalidate(scope)) return;
    probeGeneration.current += 1;
    pendingProbe.current = null;
    credentialOwner.clearScope();
    setAuthenticationError("Sign-in required. Your previous console data has been cleared.");
    setLocalLogin(null);
    setChecking(false);
    void discoverLogin(session.captureScope());
  }

  async function discoverLogin(scope: CapturedSessionScope) {
    try {
      const index = await request<{ endpoints?: { sessionLogin?: unknown } }>(session.gatewayOrigin, "/v1");
      if (scope.isCurrent()) setLocalLogin(typeof index.endpoints?.sessionLogin === "string");
    } catch {
      if (scope.isCurrent()) setAuthenticationError("Sign-in required. Sign-in options could not be loaded; retry or reload the console.");
    }
  }

  function requestForScope(scope: CapturedSessionScope): ConsoleRequest {
    return async <T,>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> => {
      if (!scope.isCurrent()) throw new Error("console session changed");
      try {
        // Do not abort or race a sent mutation: its owner holds admission until settlement.
        const value = await request<T>(baseUrl, path, init);
        if (!scope.isCurrent()) throw new Error("console session changed");
        return value;
      } catch (error) {
        if (scope.isCurrent() && authenticationRequired(error, path)) invalidate(scope);
        throw error;
      }
    };
  }

  function probe(scope: CapturedSessionScope, fresh = false): Promise<SessionResponse | null> {
    if (!scope.isCurrent()) return Promise.resolve(null);
    if (!fresh && pendingProbe.current) return pendingProbe.current;
    const generation = ++probeGeneration.current;
    const current = () => generation === probeGeneration.current && scope.isCurrent();
    const operation = request<unknown>(session.gatewayOrigin, "/v1/session").then((value) => {
      if (!current()) return null;
      if (!browserSession(value)) throw new Error("The gateway did not return a verified browser session.");
      accept(value);
      return value;
    }).catch((error) => {
      if (!current()) return null;
      if (authenticationRequired(error, "/v1/session")) {
        invalidate(scope);
        return null;
      }
      throw error;
    }).finally(() => { if (pendingProbe.current === operation) pendingProbe.current = null; });
    pendingProbe.current = operation;
    return operation;
  }

  async function recover() {
    const scope = session.captureScope();
    setChecking(true);
    setAuthenticationError("");
    try {
      await probe(scope, true);
    } catch (error) {
      if (!scope.isCurrent()) return;
      setAuthenticationError(`Unable to verify sign-in: ${errorMessage(error)}`);
    } finally {
      if (scope.isCurrent()) setChecking(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (localDemoRole() === "user") {
      const user = demo.users.find((item) => item.email === "research@example.com") ?? demo.users.find((item) => item.role === "user")!;
      accept({ ...demo.session, ...user, auth: "demo" }, true);
    } else if (session.allowDemo && new URLSearchParams(window.location.search).has("demo")) accept(demo.session, true);
    else void recover();
  }, []);

  if (!session.value.authenticated) return <LoginScreen gatewayOrigin={session.gatewayOrigin} local={localLogin === true} checking={checking} message={authenticationError} onSuccess={() => recover()} onRetry={() => recover()} />;
  // Protected editors and request content share one accepted identity lifetime.
  // Credential admission stays above it until an already-sent request settles.
  return <ConsoleDataProvider key={session.scopeEpoch} session={session} credentialOwner={credentialOwner} requestForScope={requestForScope} probe={probe} accept={accept} credentialRefresh={credentialRefresh}>{children}</ConsoleDataProvider>;
}

function ConsoleDataProvider({ session, credentialOwner, requestForScope, probe, accept, credentialRefresh, children }: {
  session: ReturnType<typeof useSession>;
  credentialOwner: CredentialOperations;
  requestForScope: (scope: CapturedSessionScope) => ConsoleRequest;
  probe: (scope: CapturedSessionScope) => Promise<SessionResponse | null>;
  accept: (value: SessionResponse, demoMode: boolean) => void;
  credentialRefresh: { current: (ownsScope: () => boolean) => Promise<void> };
  children: ReactNode;
}) {
  const scope = useRef(session.captureScope()).current;
  const scopedRequest = useRef(requestForScope(scope)).current;
  const controller = useConsoleController({
    session: {
      ...session,
      setStatus: (value) => { if (scope.isCurrent()) session.setStatus(value); },
      setRefreshError: (value) => { if (scope.isCurrent()) session.setRefreshError(value); },
      setLastUpdatedAt: (value) => { if (scope.isCurrent()) session.setLastUpdatedAt(value); },
      setRefreshing: (value) => { if (scope.isCurrent()) session.setRefreshing(value); },
      setValue: (value) => { if (scope.isCurrent()) accept(value, scope.demo); },
    },
    credentialOwner,
    request: scopedRequest,
    scope,
    verifySession: () => probe(scope),
  });
  useEffect(() => {
    const refresh = controller.refreshMetadataAfterMutation;
    credentialRefresh.current = refresh;
    return () => { if (credentialRefresh.current === refresh) credentialRefresh.current = async () => undefined; };
  }, [controller.refreshMetadataAfterMutation, credentialRefresh]);
  return <ConsoleControllerContext.Provider value={controller}>{children}</ConsoleControllerContext.Provider>;
}

export function useConsole() {
  const controller = useContext(ConsoleControllerContext);
  if (!controller) throw new Error("useConsole must be used inside ConsoleControllerProvider");
  return controller;
}
