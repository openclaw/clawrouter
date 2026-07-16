import { useRef, useState } from "react";
import { errorMessage } from "../domain";
import { generateSecret, request, sha256Hex } from "../ui-helpers";
import type { ProxyCredential } from "../ui-types";

export function useSelfServiceKeys(gatewayOrigin: string, demoMode: boolean, setStatus: (status: string) => void) {
  const [items, setItems] = useState<ProxyCredential[]>([]);
  const [policyIds, setPolicyIds] = useState<string[]>([]);
  const [issuedKey, setIssuedKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const scopeRef = useRef(`${gatewayOrigin}|`);
  const operationRef = useRef(0);

  function setPrincipal(principalId: string) {
    const scope = `${gatewayOrigin}|${principalId}`;
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    operationRef.current += 1;
    setItems([]);
    setPolicyIds([]);
    setIssuedKey("");
    setError("");
    busyRef.current = false;
    setBusy(false);
  }

  function captureHydration() {
    return operationRef.current;
  }

  function hydrate(policies: string[], credentials: ProxyCredential[], snapshot = operationRef.current) {
    if (busyRef.current || operationRef.current !== snapshot) return;
    setPolicyIds([...new Set(policies)].sort());
    setItems(credentials);
  }

  async function issue(policyId: string, credentialId?: string) {
    const operation = beginOperation();
    if (operation === null) return;
    setError("");
    setIssuedKey("");
    setStatus(credentialId ? "rotating credential" : "issuing credential");
    try {
      const id = credentialId ?? `key_${generateSecret(8)}`;
      const keyMaterial = generateSecret(24);
      const keyDigest = await sha256Hex(keyMaterial);
      const credential = demoMode
        ? { credentialId: id, policyId, enabled: true, active: true }
        : await request<ProxyCredential>(gatewayOrigin, `/v1/session/credentials/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ policyId, secretSha256: keyDigest }),
        });
      if (operationRef.current !== operation) return;
      setItems((current) => [...current.filter((item) => item.credentialId !== id), credential].sort((a, b) => a.credentialId.localeCompare(b.credentialId)));
      setIssuedKey(`clawrouter-live-${id}-${keyMaterial}`);
      setStatus(credentialId ? "rotated credential" : "issued credential");
    } catch (caught) {
      if (operationRef.current !== operation) return;
      const message = errorMessage(caught);
      setError(message);
      setStatus(`credential error: ${message}`);
    } finally {
      endOperation(operation);
    }
  }

  async function revoke(credentialId: string) {
    const operation = beginOperation();
    if (operation === null) return;
    setError("");
    setIssuedKey("");
    setStatus("revoking credential");
    try {
      const credential = demoMode
        ? { ...items.find((item) => item.credentialId === credentialId)!, enabled: false, active: false }
        : await request<ProxyCredential>(gatewayOrigin, `/v1/session/credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST" });
      if (operationRef.current !== operation) return;
      setItems((current) => current.map((item) => item.credentialId === credentialId ? credential : item));
      setStatus("revoked credential");
    } catch (caught) {
      if (operationRef.current !== operation) return;
      const message = errorMessage(caught);
      setError(message);
      setStatus(`credential error: ${message}`);
    } finally {
      endOperation(operation);
    }
  }

  function beginOperation(): number | null {
    if (busyRef.current) return null;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    busyRef.current = true;
    setBusy(true);
    return operation;
  }

  function endOperation(operation: number) {
    if (operationRef.current === operation) {
      operationRef.current += 1;
      busyRef.current = false;
      setBusy(false);
    }
  }

  return { items, policyIds, issuedKey, error, busy, setPrincipal, captureHydration, hydrate, issue, revoke };
}
