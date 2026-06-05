import React, { FormEvent, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type KeyStatus = "active" | "revoked";

interface ProviderRow {
  id: string;
  display_name: string;
  class: string;
  service_kind: string;
  meter?: string | null;
  capabilities: Array<{ id: string }>;
}

interface ProviderResponse {
  providers: ProviderRow[];
}

interface KeyPolicy {
  kid: string;
  enabled: boolean;
  providers: string[];
  tenantId?: string | null;
  monthlyBudgetMicros?: number | null;
  requestCostMicros?: number | null;
}

interface KeyListResponse {
  keys: KeyPolicy[];
}

interface AdminForm {
  kid: string;
  secret: string;
  tenantId: string;
  providers: string[];
  monthlyBudgetMicros: string;
  requestCostMicros: string;
}

const defaultForm: AdminForm = {
  kid: "svc_docs",
  secret: "",
  tenantId: "default",
  providers: ["openai", "tavily"],
  monthlyBudgetMicros: "100000000",
  requestCostMicros: "1000",
};

function App() {
  const [baseUrl, setBaseUrl] = useState(() => window.location.origin);
  const [adminToken, setAdminToken] = useState("");
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [keys, setKeys] = useState<KeyPolicy[]>([]);
  const [form, setForm] = useState<AdminForm>(defaultForm);
  const [issuedKey, setIssuedKey] = useState("");
  const [status, setStatus] = useState("idle");

  const metrics = useMemo(() => {
    const activeKeys = keys.filter((key) => key.enabled).length;
    const providerCount = providers.length;
    const monthlyBudget = keys.reduce((sum, key) => sum + (key.monthlyBudgetMicros ?? 0), 0);
    const protectedProviders = new Set(keys.flatMap((key) => key.providers)).size;
    return { activeKeys, providerCount, monthlyBudget, protectedProviders };
  }, [keys, providers]);

  async function refresh() {
    try {
      setStatus("loading");
      const [providerData, keyData] = await Promise.all([
        request<ProviderResponse>(baseUrl, "/v1/providers"),
        request<KeyListResponse>(baseUrl, "/v1/admin/keys", adminToken),
      ]);
      setProviders(providerData.providers);
      setKeys(keyData.keys);
      setStatus("loaded");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      setStatus("saving");
      if (form.providers.length === 0) {
        throw new Error("select at least one provider");
      }
      if (!/^[A-Za-z0-9_]{4,}$/.test(form.kid)) {
        throw new Error("key id must use 4 or more letters, numbers, or underscores");
      }
      const secret = form.secret || generateSecret();
      if (!/^[A-Za-z0-9_-]{8,}$/.test(secret)) {
        throw new Error("secret must use 8 or more token characters");
      }
      const policy = {
        enabled: true,
        secretSha256: await sha256Hex(secret),
        providers: form.providers,
        tenantId: form.tenantId || "default",
        monthlyBudgetMicros: optionalNumber(form.monthlyBudgetMicros),
        requestCostMicros: optionalNumber(form.requestCostMicros),
      };
      await request<KeyPolicy>(
        baseUrl,
        `/v1/admin/keys/${encodeURIComponent(form.kid)}`,
        adminToken,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(policy),
        },
      );
      setIssuedKey(`clawrouter-live-${form.kid}-${secret}`);
      setForm((current) => ({ ...current, secret }));
      await refresh();
      setStatus("saved");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function revoke(kid: string) {
    try {
      setStatus(`revoking ${kid}`);
      await request<KeyPolicy>(
        baseUrl,
        `/v1/admin/keys/${encodeURIComponent(kid)}/revoke`,
        adminToken,
        { method: "POST" },
      );
      await refresh();
      setStatus(`revoked ${kid}`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  function toggleProvider(providerId: string) {
    setForm((current) => {
      const selected = current.providers.includes(providerId);
      const providers = selected
        ? current.providers.filter((id) => id !== providerId)
        : [...current.providers, providerId].sort();
      return { ...current, providers };
    });
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>ClawRouter</h1>
          <p>Provider keys, OAuth grants, budgets, and service routing.</p>
        </div>
        <span className="role">admin</span>
      </header>

      <section className="controls" aria-label="connection">
        <label>
          <span>gateway</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label>
          <span>admin token</span>
          <input
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
            type="password"
            autoComplete="off"
          />
        </label>
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      </section>

      <section className="metrics" aria-label="usage summary">
        <Metric label="providers" value={String(metrics.providerCount)} />
        <Metric label="active keys" value={String(metrics.activeKeys)} />
        <Metric label="protected providers" value={String(metrics.protectedProviders)} />
        <Metric label="monthly budget" value={formatMicros(metrics.monthlyBudget)} />
      </section>

      <section className="grid">
        <form className="panel keyForm" onSubmit={submit}>
          <div className="panelHeader">
            <h2>Key Policy</h2>
            <span className="muted">{status}</span>
          </div>
          <div className="formGrid">
            <label>
              <span>key id</span>
              <input
                value={form.kid}
                onChange={(event) => setForm({ ...form, kid: event.target.value })}
              />
            </label>
            <label>
              <span>secret</span>
              <div className="inline">
                <input
                  value={form.secret}
                  onChange={(event) => setForm({ ...form, secret: event.target.value })}
                  type="password"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setForm({ ...form, secret: generateSecret() })}
                >
                  Generate
                </button>
              </div>
            </label>
            <label>
              <span>tenant</span>
              <input
                value={form.tenantId}
                onChange={(event) => setForm({ ...form, tenantId: event.target.value })}
              />
            </label>
            <label>
              <span>monthly micros</span>
              <input
                inputMode="numeric"
                value={form.monthlyBudgetMicros}
                onChange={(event) =>
                  setForm({ ...form, monthlyBudgetMicros: event.target.value })
                }
              />
            </label>
            <label>
              <span>request micros</span>
              <input
                inputMode="numeric"
                value={form.requestCostMicros}
                onChange={(event) => setForm({ ...form, requestCostMicros: event.target.value })}
              />
            </label>
          </div>
          <div className="providerPicker" aria-label="provider allowlist">
            {providers.map((provider) => (
              <label key={provider.id} className="check">
                <input
                  type="checkbox"
                  checked={form.providers.includes(provider.id)}
                  onChange={() => toggleProvider(provider.id)}
                />
                <span>{provider.id}</span>
              </label>
            ))}
          </div>
          <div className="actions">
            <button type="submit">Save policy</button>
          </div>
          {issuedKey ? <output className="issuedKey">{issuedKey}</output> : null}
        </form>

        <section className="panel">
          <div className="panelHeader">
            <h2>Keys</h2>
            <span className="muted">{keys.length}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>key</th>
                <th>tenant</th>
                <th>providers</th>
                <th>budget</th>
                <th>status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.kid}>
                  <td>{key.kid}</td>
                  <td>{key.tenantId ?? "default"}</td>
                  <td>{key.providers.length ? key.providers.join(", ") : "all"}</td>
                  <td>{formatBudget(key.monthlyBudgetMicros)}</td>
                  <td>
                    <span className={`status ${keyStatus(key)}`}>{keyStatus(key)}</span>
                  </td>
                  <td>
                    <button type="button" disabled={!key.enabled} onClick={() => revoke(key.kid)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </section>

      <section className="panel providerPanel">
        <div className="panelHeader">
          <h2>Providers</h2>
          <span className="muted">{providers.length}</span>
        </div>
        <div className="providerGrid">
          {providers.map((provider) => (
            <div className="providerRow" key={provider.id}>
              <strong>{provider.id}</strong>
              <span>{provider.class}</span>
              <span>{provider.service_kind}</span>
              <span>{provider.capabilities.map((capability) => capability.id).join(", ")}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function keyStatus(key: KeyPolicy): KeyStatus {
  return key.enabled ? "active" : "revoked";
}

async function request<T>(
  baseUrl: string,
  path: string,
  adminToken?: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (adminToken) {
    headers.set("authorization", `Bearer ${adminToken}`);
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function sha256Hex(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function generateSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function optionalNumber(value: string) {
  if (!value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${value} is not a non-negative safe integer`);
  }
  return parsed;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatBudget(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return "unlimited";
  }
  if (value === 0) {
    return "blocked";
  }
  return formatMicros(value);
}

function formatMicros(value: number) {
  if (!value) {
    return "none";
  }
  return `$${(value / 1_000_000).toFixed(2)}`;
}

createRoot(document.getElementById("root")!).render(<App />);
