// Proof-only entry. The builder inserts the marked observer into a separate
// capsule module so the candidate never imports its own entry recursively.
// BEGIN EDGE OBSERVER
type ProofOperation = { kind: string; original: unknown; state: "pending" | "fulfilled" | "rejected" | "sync_throw"; reason?: unknown; invoked: number; settled: number | null };
type ProofState = { id: string; signal: AbortSignal; upstream: string; credential: string; fetches: Array<{ exact: boolean; ingressAtInvoke: boolean; effectiveAtInvoke: boolean | null; ingressAtSettle: boolean | null; effectiveAtSettle: boolean | null }>; protocol: string | null; sequence: number; invalid: boolean; overflow: boolean; operations: ProofOperation[]; readers: Map<object, { body: ReadableStream; unlocks: number }>; aborted: boolean };
const edgeOwners = new WeakMap<object, ProofState>();
let edgeUnbound = 0;
function edgeObject(value: unknown): value is object { return value !== null && (typeof value === "object" || typeof value === "function"); }
export function edgeBind(value: unknown, source: unknown): void {
  try { const state = edgeObject(source) ? edgeOwners.get(source) : undefined; if (state && edgeObject(value)) edgeOwners.set(value, state); else edgeUnbound++; } catch { edgeUnbound++; }
}
export function edgeTransfer<T>(value: T, source: unknown): T {
  edgeBind(value, source);
  try { if (value instanceof Response && value.body) edgeBind(value.body, source); } catch { edgeUnbound++; }
  return value;
}
export function edgeIngress(request: Request, id: string, upstream: string, credential: string): ProofState {
  const protocol = (request as Request & { cf?: { httpProtocol?: string } }).cf?.httpProtocol;
  const state: ProofState = { id, signal: request.signal, upstream, credential, fetches: [], protocol: ["HTTP/1.0", "HTTP/1.1", "HTTP/2", "HTTP/3"].includes(protocol ?? "") ? protocol! : null, sequence: 0, invalid: false, overflow: false, operations: [], readers: new Map(), aborted: request.signal.aborted };
  edgeOwners.set(request, state); edgeOwners.set(request.signal, state);
  return state;
}
function edgeTrack(state: ProofState, kind: string, original: unknown): void {
  if (state.operations.length >= 256) { state.overflow = true; return; }
  const record: ProofOperation = { kind, original, state: "pending", invoked: ++state.sequence, settled: null };
  state.operations.push(record);
  if (!(original instanceof Promise)) {
    if (["fetch", "read", "cancel", "closed", "task", "retirement", "source_tail"].includes(kind)) state.invalid = true;
    record.state = "fulfilled"; record.settled = ++state.sequence; return;
  }
  void original.then(value => {
    try { record.state = "fulfilled"; record.settled = ++state.sequence; if (kind === "fetch") edgeTransfer(value, state.signal); } catch { state.invalid = true; }
  }, reason => {
    try { record.state = "rejected"; record.reason = reason; record.settled = ++state.sequence; } catch { state.invalid = true; }
  }).catch(() => { state.invalid = true; });
}
export function edgeObserve<T>(kind: string, owner: unknown, invoke: () => T): T {
  let state: ProofState | undefined;
  try { state = edgeObject(owner) ? edgeOwners.get(owner) : undefined; if (!state) edgeUnbound++; } catch { edgeUnbound++; }
  let result: T;
  try { result = invoke(); }
  catch (reason) {
    try { if (state) { if (state.operations.length >= 256) state.overflow = true; else state.operations.push({ kind, original: undefined, state: "sync_throw", reason, invoked: ++state.sequence, settled: ++state.sequence }); } } catch { if (state) state.invalid = true; }
    throw reason;
  }
  try {
    if (state) {
      if (kind === "reader") {
        edgeOwners.set(result as object, state);
        state.readers.set(result as object, { body: owner as ReadableStream, unlocks: 0 });
        edgeTrack(state, "closed", (result as ReadableStreamDefaultReader).closed);
      } else {
        edgeTrack(state, kind, result);
        if (kind === "unlock") { const reader = state.readers.get(owner as object); if (!reader || result !== undefined) state.invalid = true; else reader.unlocks++; }
      }
    }
  } catch { if (state) state.invalid = true; else edgeUnbound++; }
  return result;
}
export function edgeTask(request: Request, pending: Promise<unknown>): void {
  try { const state = edgeOwners.get(request); if (state) edgeTrack(state, "task", pending); else edgeUnbound++; } catch { edgeUnbound++; }
}
export function edgeFactory<T extends (...args: any[]) => any>(factory: T): T {
  return function (this: unknown, ...args: Parameters<T>) {
    const value = edgeObserve("factory", args[0], () => Reflect.apply(factory, this, args));
    try {
      const state = edgeOwners.get(args[0]);
      if (state) { edgeTrack(state, "retirement", value.retired); if (args[1] !== undefined) edgeTrack(state, "source_tail", args[1]); }
      else edgeUnbound++;
    } catch { edgeUnbound++; }
    return value;
  } as T;
}
export function edgeFetch<T extends (...args: any[]) => any>(original: T, request: Request): T {
  return function (this: unknown, ...args: Parameters<T>) {
    const state = edgeOwners.get(request);
    let record: ProofState["fetches"][number] | undefined, signal: AbortSignal | null | undefined;
    try {
      if (!state || state.fetches.length !== 0) { if (state) state.invalid = true; else edgeUnbound++; }
      else {
        const [input, init] = args, url = new URL(input);
        signal = init.signal;
        record = { exact: url.origin === state.upstream && !url.search && ((init.method === "GET" && url.pathname === "/models") || (init.method === "POST" && url.pathname === "/chat/completions")) && new Headers(init.headers).get("authorization") === "Bearer " + state.credential && init.redirect === "manual", ingressAtInvoke: state.signal.aborted, effectiveAtInvoke: signal instanceof AbortSignal ? signal.aborted : null, ingressAtSettle: null, effectiveAtSettle: null };
        state.fetches.push(record); if (!record.exact || record.effectiveAtInvoke === null) state.invalid = true;
      }
    } catch { if (state) state.invalid = true; else edgeUnbound++; }
    const pending = edgeObserve("fetch", request, () => Reflect.apply(original, this, args));
    try {
      const settled = () => { try { if (record && state) { record.ingressAtSettle = state.signal.aborted; record.effectiveAtSettle = signal instanceof AbortSignal ? signal.aborted : null; } } catch { if (state) state.invalid = true; } };
      void pending.then(settled, settled).catch(() => { if (state) state.invalid = true; });
    } catch { if (state) state.invalid = true; else edgeUnbound++; }
    return pending;
  } as T;
}
export async function edgeJoin(state: ProofState) {
  let cursor = 0;
  while (cursor < state.operations.length) {
    const batch = state.operations.slice(cursor); cursor += batch.length;
    await Promise.allSettled(batch.map(record => record.original));
  }
  state.aborted = state.signal.aborted;
  const readers = [...state.readers.values()];
  const records = state.operations.map(record => ({ kind: record.kind, state: record.state, invoked: record.invoked, settled: record.settled, reasonDefined: record.state === "rejected" || record.state === "sync_throw" ? record.reason !== undefined : null }));
  return { id: state.id, protocol: state.protocol, ingressAborted: state.aborted, fetches: state.fetches, invalid: state.invalid || edgeUnbound !== 0, overflow: state.overflow, records,
    readers: readers.length, unlocked: readers.every(reader => reader.unlocks === 1 && !reader.body.locked),
    strict: !state.invalid && !state.overflow && edgeUnbound === 0 && state.protocol !== null && state.fetches.length === 1 && state.fetches[0].exact && records.every(record => record.state === "fulfilled") && readers.every(reader => reader.unlocks === 1 && !reader.body.locked) };
}
// END EDGE OBSERVER

// Imports below are rewritten ONLY inside the immutable source capsule.
import candidate from "../index.ts";
export { PolicyBindingIndexObject, BudgetLedgerObject, GrantCredentialObject, UsageLedgerObject } from "../index.ts";
import { authorityCall } from "../authority.ts";
import { putGrantCredentials } from "../grant-credentials.ts";
import { sha256Hex } from "../utils.ts";
import { budgetStatus } from "../ledgers.ts";
import { usageSnapshot } from "../usage-ledger-client.ts";
import type { Env } from "../types.ts";

type Case = { id: string; role: "eof" | "preabort" | "partial_abort" | "provider_error"; api: "stream" | "streamSimple"; proxy: string; upstream: string; control: string };
type ProofEnv = Env & { LITELLM_BASE_URL: string; LITELLM_MODEL: string; EDGE_PROOF_SECRET: string; EDGE_PROOF_RUN: string; EDGE_PROOF_EXPIRES: string; EDGE_PROOF_SOURCE: string; EDGE_PROOF_TREE: string; EDGE_PROOF_ORIGIN: string; EDGE_PROOF_UPSTREAM: string; PROOF_RECORDS: DurableObjectNamespace };
type Secret = { admin: string; cases: Case[] };
function secret(env: ProofEnv): Secret {
  let value: Secret;
  try { value = JSON.parse(env.EDGE_PROOF_SECRET) as Secret; } catch { throw new Error("invalid proof authority"); }
  const tokens = [value.admin, ...value.cases.flatMap(row => [row.proxy, row.upstream, row.control])];
  if (value.cases.length !== 8 || value.cases.some(row => !["stream", "streamSimple"].includes(row.api) || !["eof", "preabort", "partial_abort", "provider_error"].includes(row.role) || row.id !== `${row.api === "stream" ? "stream" : "simple"}_${row.role}`) || new Set(value.cases.map(row => row.id)).size !== 8 || tokens.some(token => !/^[a-f0-9]{64}$/.test(token)) || new Set(tokens).size !== tokens.length) throw new Error("invalid proof authority");
  return value;
}
function owner(env: ProofEnv, id: string) { return env.PROOF_RECORDS.get(env.PROOF_RECORDS.idFromName(env.EDGE_PROOF_RUN + "/" + id)); }
async function ownerCall(env: ProofEnv, id: string, action: string, data?: unknown) {
  return owner(env, id).fetch("https://proof.invalid/" + action, { method: "POST", body: JSON.stringify(data ?? {}) });
}
export async function initializeProofAuthorities(env: ProofEnv, credentials: Secret) {
  // The original authority's initialize-all fences are global, not per case.
  // Every admitted row must be in the first batch, even though controls remain
  // single-use and grant attachment stays local to the selected case.
  await authorityCall(env, "/policies/initialize-all", credentials.cases.map(row => ({ policyId: row.id, policy: { enabled: true, generation: env.EDGE_PROOF_RUN, providers: ["litellm"], tenantId: env.EDGE_PROOF_RUN, monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false, grantRouting: { environmentFallback: false } } })));
  const entries = await Promise.all(credentials.cases.map(async row => ({ credentialId: row.id, credential: { enabled: true, secretSha256: await sha256Hex(row.proxy), policyId: row.id, policyGeneration: env.EDGE_PROOF_RUN } })));
  await authorityCall(env, "/credentials/initialize-all", entries);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "litellm", enabled: true }]);
}
export class ProofRecords {
  constructor(private state: DurableObjectState) {}
  async fetch(request: Request) {
    const action = new URL(request.url).pathname;
    if (action === "/claim") {
      const key = "claim/" + (await request.json() as { kind: string }).kind;
      return this.state.storage.transaction(async storage => { if (await storage.get(key)) return new Response(null, { status: 409 }); await storage.put(key, true); return new Response(null, { status: 204 }); });
    }
    if (action === "/record") {
      const data = await request.json() as { kind: string; proof: unknown };
      const key = "record/" + data.kind;
      if (await this.state.storage.get(key)) return new Response(null, { status: 409 });
      await this.state.storage.put(key, data.proof); return new Response(null, { status: 204 });
    }
    if (action === "/state") return Response.json(Object.fromEntries(await this.state.storage.list({ prefix: "record/", limit: 4 })));
    return new Response(null, { status: 404 });
  }
}
export default {
  async fetch(request: Request<unknown, IncomingRequestCfProperties>, env: ProofEnv, context: ExecutionContext) {
    const expires = Number(env.EDGE_PROOF_EXPIRES);
    if (!Number.isSafeInteger(expires) || Date.now() >= expires || expires - Date.now() > 600000 || !/^[a-f0-9]{32}$/.test(env.EDGE_PROOF_RUN) || env.EDGE_PROOF_SOURCE !== "5cfafe8c8df43102365ec900431b8b3be1dd4eb0" || env.EDGE_PROOF_TREE !== "6da1d6ea30f74d18730365c875b2978c61f34ce2") return new Response(null, { status: 410 });
    const origin = /^https:\/\/clawrouter-edge-proof\.([a-z0-9-]+)\.workers\.dev$/.exec(env.EDGE_PROOF_ORIGIN);
    if (!origin || env.EDGE_PROOF_UPSTREAM !== `https://clawrouter-upstream-proof.${origin[1]}.workers.dev` || env.LITELLM_BASE_URL !== env.EDGE_PROOF_UPSTREAM || env.LITELLM_MODEL !== "tenant/edge-proof" || "LITELLM_API_KEY" in env || "OPENAI_API_KEY" in env) return new Response(null, { status: 503 });
    const url = new URL(request.url), auth = request.headers.get("authorization"), credentials = secret(env);
    if (url.origin !== env.EDGE_PROOF_ORIGIN || url.search) return new Response(null, { status: 400 });
    const control = /^\/__proof\/(init|state|usage)\/([a-z_]+)$/.exec(url.pathname);
    if (control) {
      const row = credentials.cases.find(row => row.id === control[2]);
      if (!row || auth !== "Bearer " + (control[1] === "init" ? credentials.admin : row.control) || request.method !== "POST" || request.headers.has("content-type") || request.body !== null) return new Response(null, { status: 403 });
      if (control[1] === "init") {
        if ((await ownerCall(env, row.id, "claim", { kind: "init" })).status !== 204) return new Response(null, { status: 409 });
        await initializeProofAuthorities(env, credentials);
        await putGrantCredentials(env, "oauth/" + row.id + "/litellm", { provider: "litellm", kind: "api_key", enabled: true, credential: row.upstream });
        return new Response(null, { status: 204 });
      }
      if ((await ownerCall(env, row.id, "claim", { kind: control[1] })).status !== 204) return new Response(null, { status: 409 });
      if (control[1] === "state") return ownerCall(env, row.id, "state");
      // The real SQLite owners serve their original snapshots, never a local accounting estimate.
      const usage = await usageSnapshot(env, env.EDGE_PROOF_RUN, row.id, { kind: "admin" });
      const budget = await budgetStatus(env, row.id, { tenantId: env.EDGE_PROOF_RUN, monthlyBudgetMicros: 100 });
      return Response.json({ usage, budget });
    }
    const row = credentials.cases.find(row => auth === "Bearer clawrouter-live-" + row.id + "-" + row.proxy);
    const kind = request.method === "GET" && url.pathname === "/v1/native/litellm/v1/models" ? "catalog" : request.method === "POST" && url.pathname === "/v1/native/litellm/v1/chat/completions" ? "inference" : null;
    if (!row || !kind || request.headers.has("x-api-key") || Number(request.headers.get("content-length") ?? 0) > 8192) return new Response(null, { status: 403 });
    const state = edgeIngress(request, row.id, env.EDGE_PROOF_UPSTREAM, row.upstream);
    if ((await ownerCall(env, row.id, "claim", { kind })).status !== 204) return new Response(null, { status: 409 });
    const delegated = new Proxy(context, { get(target, property) {
      if (property === "waitUntil") return (pending: Promise<unknown>) => { edgeTask(request, pending); return Reflect.apply(target.waitUntil, target, [pending]); };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    let response: Response;
    try { response = await candidate.fetch!(request, env, delegated); }
    finally {
      const reporting = edgeJoin(state).then(async proof => {
        const receipt = await ownerCall(env, row.id, "record", { kind, proof });
        if (receipt.status !== 204) throw new Error("proof receipt refused");
      });
      // Observer registration must not replace an original handler exception,
      // including a synchronous/async throw of undefined.
      void reporting.catch(() => { state.invalid = true; });
      try { context.waitUntil(reporting); } catch { state.invalid = true; }
    }
    return response;
  },
  queue: candidate.queue,
};
