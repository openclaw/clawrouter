import { useState } from "react";
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

  async function setEnabled(providerId: string, enabled: boolean) {
    try {
      setStatus(`${enabled ? "enabling" : "disabling"} ${providerId}`);
      const current = connections.find((connection) => connection.providerId === providerId);
      const next: ProviderConnection = { providerId, enabled, label: current?.label ?? null };
      if (demoMode) {
        setConnections((items) => [next, ...items.filter((item) => item.providerId !== providerId)]);
        setProviderReadiness((items) => {
          const readiness = items[providerId];
          return readiness ? { ...items, [providerId]: { ...readiness, connectionEnabled: enabled, executable: enabled && readiness.configPresent && (!readiness.oauthGrantRequired || readiness.oauthGrantCount > 0), status: enabled ? (readiness.verified ? "verified" : "unverified") : "disabled" } } : items;
        });
      } else {
        await request<ProviderConnection>(gatewayOrigin, `/v1/admin/connections/${encodeURIComponent(providerId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
        await refresh();
      }
      setStatus(`${enabled ? "enabled" : "disabled"} ${providerId}`);
    } catch (caught) {
      setStatus(errorMessage(caught));
    }
  }

  return { connections: { items: connections, setItems: setConnections, setEnabled }, hydrate: setConnections };
}
