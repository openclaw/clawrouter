import { useRef, useState } from "react";
import { errorMessage } from "../../domain";
import { demo } from "../../ui-config";
import { request } from "../../ui-helpers";
import type { ProviderConnection, ProviderReadiness } from "../../ui-types";

interface Dependencies {
  allowDemo: boolean;
  gatewayOrigin: string;
  demoMode: boolean;
  setStatus: (status: string) => void;
  setProviderReadiness: React.Dispatch<React.SetStateAction<Record<string, ProviderReadiness>>>;
  refresh: () => Promise<void>;
}

export function useConnectionAdmin({ allowDemo, gatewayOrigin, demoMode, setStatus, setProviderReadiness, refresh }: Dependencies) {
  const [connections, setConnections] = useState<ProviderConnection[]>(allowDemo ? demo.connections : []);
  const pendingRef = useRef(new Set<string>());
  const [pendingProviderIds, setPendingProviderIds] = useState<ReadonlySet<string>>(new Set());

  async function mutate(providerId: string, mutation: Partial<Pick<ProviderConnection, "enabled" | "monthlyBudgetMicros">>, pending: string, completed: string) {
    if (pendingRef.current.has(providerId)) return;
    pendingRef.current.add(providerId);
    setPendingProviderIds(new Set(pendingRef.current));
    try {
      setStatus(pending);
      if (demoMode) {
        setConnections((items) => {
          const current = items.find((item) => item.providerId === providerId);
          const next = { providerId, enabled: true, ...current, ...mutation };
          if (mutation.monthlyBudgetMicros !== undefined) next.remainingMicros = mutation.monthlyBudgetMicros === null || current?.spentMicros == null ? null : Math.max(0, mutation.monthlyBudgetMicros - current.spentMicros);
          return [next, ...items.filter((item) => item.providerId !== providerId)];
        });
        const enabled = mutation.enabled;
        if (enabled !== undefined) setProviderReadiness((items) => {
          const readiness = items[providerId];
          return readiness ? { ...items, [providerId]: { ...readiness, connectionEnabled: enabled, executable: enabled && readiness.configPresent && (!readiness.oauthGrantRequired || readiness.oauthGrantCount > 0), status: enabled ? (readiness.verified ? "verified" : "unverified") : "disabled" } } : items;
        });
      } else {
        const next = await request<ProviderConnection>(gatewayOrigin, `/v1/admin/connections/${encodeURIComponent(providerId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(mutation) });
        setConnections((items) => [next, ...items.filter((item) => item.providerId !== providerId)]);
        await refresh();
      }
      setStatus(completed);
    } catch (caught) {
      setStatus(`connection error: ${errorMessage(caught)}`);
    } finally {
      pendingRef.current.delete(providerId);
      setPendingProviderIds(new Set(pendingRef.current));
    }
  }

  function setEnabled(providerId: string, enabled: boolean) {
    return mutate(providerId, { enabled }, `${enabled ? "enabling" : "disabling"} ${providerId}`, `${enabled ? "enabled" : "disabled"} ${providerId}`);
  }

  function setBudget(providerId: string, monthlyBudgetMicros: number | null) {
    return mutate(providerId, { monthlyBudgetMicros }, `saving ${providerId} budget`, `saved ${providerId} budget`);
  }

  function hydrate(items: ProviderConnection[]) {
    // A refresh started before a write must not replace its committed response.
    const pending = new Set(pendingRef.current);
    setConnections((current) => items.map((item) => pending.has(item.providerId) ? current.find((connection) => connection.providerId === item.providerId) ?? item : item));
  }

  return { connections: { items: connections, setItems: setConnections, pendingProviderIds, setEnabled, setBudget }, hydrate };
}
