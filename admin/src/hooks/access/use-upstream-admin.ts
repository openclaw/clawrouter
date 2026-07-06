import { type FormEvent, useState } from "react";
import { errorMessage } from "../../domain";
import { defaultUpstreamGrant, demo } from "../../ui-config";
import { demoGrantFromForm, parseCredentialBundle, request, upstreamGrantFormFromGrant } from "../../ui-helpers";
import type { AccessPolicy, ProviderRow, UpstreamGrant, UpstreamGrantForm } from "../../ui-types";

interface Dependencies {
  allowDemo: boolean;
  gatewayOrigin: string;
  demoMode: boolean;
  providers: ProviderRow[];
  policies: AccessPolicy[];
  selectedPolicyId: string;
  setError: (message: string) => void;
  setStatus: (status: string) => void;
  refresh: () => Promise<void>;
}

export function useUpstreamAdmin({ allowDemo, gatewayOrigin, demoMode, providers, policies, selectedPolicyId, setError, setStatus, refresh }: Dependencies) {
  const [grants, setGrants] = useState<UpstreamGrant[]>(allowDemo ? demo.upstreamGrants : []);
  const [form, setForm] = useState<UpstreamGrantForm>(allowDemo && demo.upstreamGrants[0] ? upstreamGrantFormFromGrant(demo.upstreamGrants[0]) : defaultUpstreamGrant);
  const [selectedKey, setSelectedKey] = useState(allowDemo ? demo.upstreamGrants[0]?.key ?? "" : "");
  const selected = grants.find((grant) => grant.key === selectedKey);

  function hydrate(nextGrants: UpstreamGrant[], background: boolean, policyId: string, providerRows: ProviderRow[]) {
    setGrants(nextGrants);
    if (background) return;
    const refreshed = nextGrants.find((grant) => grant.key === selectedKey) ?? nextGrants[0];
    setSelectedKey(refreshed?.key ?? "");
    setForm(refreshed ? upstreamGrantFormFromGrant(refreshed) : { ...defaultUpstreamGrant, scopeId: policyId, provider: providerRows[0]?.id ?? "", tokenRef: providerRows[0]?.id ?? "" });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      setError("");
      const scopeId = form.scopeId.trim(), tokenRef = form.tokenRef.trim(), provider = form.provider.trim();
      if (!scopeId || !tokenRef || !provider) throw new Error("scope, token reference, and provider are required");
      const priority = Number(form.priority);
      if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) throw new Error("priority must be an integer from 0 to 1000000");
      const credentialBundle = parseCredentialBundle(form.credentialBundle);
      const primarySecret = form.kind === "api_key" ? form.credential.trim() || Object.keys(credentialBundle).length : form.accessToken.trim();
      if (!selected && !primarySecret) throw new Error("a new upstream grant requires its primary secret");
      const body = {
        version: 1, enabled: form.enabled, priority, kind: form.kind, provider, label: form.label.trim() || undefined,
        tokenType: selected?.tokenType ?? "Bearer", expiresAt: form.expiresAt.trim() || undefined, scopes: selected?.scopes ?? [],
        accountId: form.accountId.trim() || undefined, subscription: selected?.subscription ?? undefined,
        ...(form.credential.trim() ? { credential: form.credential.trim() } : {}),
        ...(Object.keys(credentialBundle).length ? { credentials: credentialBundle } : {}),
        ...(form.accessToken.trim() ? { accessToken: form.accessToken.trim() } : {}),
        ...(form.refreshToken.trim() ? { refreshToken: form.refreshToken.trim() } : {}),
      };
      const path = `/v1/admin/upstream-grants/${form.scope}/${encodeURIComponent(scopeId)}/${encodeURIComponent(tokenRef)}`;
      setStatus("saving upstream grant");
      let saved: UpstreamGrant;
      if (demoMode) { saved = demoGrantFromForm(form, selected); setGrants((current) => [saved, ...current.filter((grant) => grant.key !== saved.key)]); }
      else { saved = await request<UpstreamGrant>(gatewayOrigin, path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); await refresh(); }
      setSelectedKey(saved.key);
      setForm(upstreamGrantFormFromGrant(saved));
      setStatus("saved upstream grant");
    } catch (caught) { handleError(caught); }
  }

  async function revoke(grant: UpstreamGrant) {
    try {
      setError("");
      setStatus("revoking upstream grant");
      let revoked: UpstreamGrant;
      if (demoMode) {
        revoked = { ...grant, enabled: false, usable: false, hasCredential: false, credentialFields: [], hasAccessToken: false, hasRefreshToken: false, revokedAt: new Date().toISOString() };
        setGrants((current) => current.map((item) => item.key === grant.key ? revoked : item));
      } else { revoked = await request<UpstreamGrant>(gatewayOrigin, `/v1/admin/upstream-grants/${grant.scope}/${encodeURIComponent(grant.scopeId)}/${encodeURIComponent(grant.tokenRef)}/revoke`, { method: "POST" }); await refresh(); }
      setSelectedKey(revoked.key);
      setForm(upstreamGrantFormFromGrant(revoked));
      setStatus("revoked upstream grant");
    } catch (caught) { handleError(caught); }
  }

  async function refreshGrant(grant: UpstreamGrant) {
    try {
      setError("");
      setStatus("refreshing upstream grant");
      if (!demoMode) {
        const refreshed = await request<UpstreamGrant>(gatewayOrigin, `/v1/admin/upstream-grants/${grant.scope}/${encodeURIComponent(grant.scopeId)}/${encodeURIComponent(grant.tokenRef)}/refresh`, { method: "POST" });
        await refresh();
        setSelectedKey(refreshed.key);
        setForm(upstreamGrantFormFromGrant(refreshed));
      }
      setStatus("refreshed upstream grant");
    } catch (caught) { handleError(caught); }
  }

  async function authorize() {
    try {
      setError("");
      const scopeId = form.scopeId.trim(), tokenRef = form.tokenRef.trim(), provider = form.provider.trim();
      if (!scopeId || !tokenRef || !provider) throw new Error("scope, token reference, and provider are required");
      const priority = Number(form.priority);
      if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) throw new Error("priority must be an integer from 0 to 1000000");
      if (!providers.find((item) => item.id === provider)?.auth?.authorization) throw new Error("selected provider does not support browser OAuth");
      setStatus("connecting upstream grant");
      if (demoMode) { setStatus("browser OAuth unavailable in local demo"); return; }
      const result = await request<{ authorizationUrl: string }>(gatewayOrigin, `/v1/admin/upstream-grants/${form.scope}/${encodeURIComponent(scopeId)}/${encodeURIComponent(tokenRef)}/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, priority }) });
      window.location.assign(result.authorizationUrl);
    } catch (caught) { handleError(caught); }
  }

  function edit(grant: UpstreamGrant) { setSelectedKey(grant.key); setForm(upstreamGrantFormFromGrant(grant)); }
  function startNew() { const provider = providers[0]?.id ?? ""; setSelectedKey(""); setForm({ ...defaultUpstreamGrant, scopeId: selectedPolicyId || policies[0]?.policyId || "default", provider, tokenRef: provider }); }
  function handleError(caught: unknown) { const message = errorMessage(caught); setError(message); setStatus(message); }

  return { upstream: { items: grants, setItems: setGrants, selected, selectedKey, setSelectedKey, form, setForm, save, revoke, refresh: refreshGrant, authorize, edit, startNew }, hydrate };
}
