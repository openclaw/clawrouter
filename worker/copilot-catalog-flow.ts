import { assertCopilotAccountRecord, type CopilotAccountBinding } from "./copilot-account-flow.ts";
import { readCopilotDeviceJson } from "./copilot-device-admin.ts";
import { copilotAccountRequest, copilotCatalogRequest, copilotModelFormats, qualifyCopilotIdentity, type CopilotRuntimeIdentity, type CopilotWireFormat } from "./provider-copilot.ts";
import { readCopilotAccountResponse } from "./copilot-account-response.ts";
import { readCopilotResponseText } from "./copilot-response-body.ts";
import { decodeCopilotModelCatalog, type CopilotModelCatalog } from "./provider-copilot-catalog.ts";
import { assertControlCallerLive, authorizeResponseControl, type ResponseControlAuthorization } from "./response-control-authorization.ts";
import { policyAllowsModel } from "./policy-models.ts";
import { grantRoutingPolicy } from "./grant-routing.ts";
import { HttpOperation } from "./http-operation.ts";
import { inputRetirement } from "./input-retirement.ts";
import { jsonBodyTransport } from "./json-body.ts";
import { BodyLease } from "./body-budget.ts";
import { HttpError, sha256Hex } from "./utils.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import type { AccessPolicy, Env } from "./types.ts";

const provider = "github-copilot", MiB = 1024 * 1024;
const unavailable = () => new HttpError(409, "copilot_catalog_unavailable", "Original Copilot catalog authority unavailable");
export interface CopilotCatalogOwner {
  order<T>(run: () => Promise<T>): Promise<T>;
  read(): Promise<CredentialRecord | undefined>;
  retain(work: Promise<void>): void;
}
// PRIVATE Worker-to-owner input. No public route accepts this DTO. Runtime
// identity comes from the server caller, never forwarded client headers.
export interface CopilotCatalogInput {
  key: string;
  expectedGeneration: number;
  expectedLineage: string;
  deviceAttemptId: string;
  accountAttemptId: string;
  authorization: ResponseControlAuthorization;
  runtimeIdentity: CopilotRuntimeIdentity;
  deadline: number;
  selection?: Readonly<{ modelId: string; format: CopilotWireFormat }>;
}
type Scope = { binding: CopilotAccountBinding; token: string };
type Active = { operation: HttpOperation; responses: Response[] };
type CatalogView = {
  version: "clawrouter.copilot-catalog.v1";
  observationId: string;
  observedAt: number;
  generation: number;
  lineage: string;
  accountAttemptId: string;
  data: CopilotModelCatalog["data"];
  // A diagnostic selection handoff for THIS operation, not a reusable permit.
  selection: { eligible: false } | { eligible: true; modelId: string; upstreamId: string; format: CopilotWireFormat };
};

function input(value: unknown): CopilotCatalogInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const v = value as Record<string, unknown>;
  const fields = ["key", "expectedGeneration", "expectedLineage", "deviceAttemptId", "accountAttemptId", "authorization", "runtimeIdentity", "deadline", "selection"];
  const id = (x: unknown) => typeof x === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(x);
  if (Object.keys(v).some(k => !fields.includes(k)) || typeof v.key !== "string" || v.key.length > 512
    || !/^oauth\/(?:tenants\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(v.key)
    || !Number.isSafeInteger(v.expectedGeneration) || (v.expectedGeneration as number) < 1
    || !id(v.expectedLineage) || !id(v.deviceAttemptId) || !id(v.accountAttemptId)
    || !Number.isSafeInteger(v.deadline) || (v.deadline as number) <= Date.now() || (v.deadline as number) - Date.now() > 30_000) throw unavailable();
  const a = v.authorization as ResponseControlAuthorization | undefined;
  if (a?.kind !== "public" || !a.binding?.proof || !v.runtimeIdentity) throw unavailable();
  if (v.selection !== undefined) {
    const s = v.selection as Record<string, unknown>;
    if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).length !== 2
      || typeof s.modelId !== "string" || !s.modelId.startsWith(provider + "/") || s.modelId.length > provider.length + 513
      || !["openai.chat_completions", "openai.responses", "anthropic.messages"].includes(s.format as string)) throw unavailable();
  }
  return v as unknown as CopilotCatalogInput;
}

export class CopilotCatalogFlow {
  private active?: Active;
  private readonly owner: CopilotCatalogOwner;
  private readonly env: Env;
  constructor(owner: CopilotCatalogOwner, env: Env) { this.owner = owner; this.env = env; }

  // Called under credential ordering; do not join remote cleanup on this tail.
  invalidate(): void { this.active?.operation.stop("caller"); }

  async fetch(request: Request): Promise<Response> {
    const control = new BodyLease(), allocation = new BodyLease();
    let active: Active | undefined, physical = Promise.resolve();
    const release = () => { allocation.release(); control.release(); if (this.active === active) this.active = undefined; };
    try {
      if (!control.grow(MiB)) throw new HttpError(503, "body_capacity_exhausted", "Request capacity unavailable");
      const selected = input(await readCopilotDeviceJson(request));
      const operation = new HttpOperation(request.signal, selected.deadline - Date.now());
      active = { operation, responses: [] };
      const current = active;
      await this.owner.order(async () => {
        if (this.active) throw unavailable();
        operation.signal.throwIfAborted();
        // One combined operational charge for BOTH responses and all parsing /
        // publication owners; no nested 64 MiB account-flow reservation.
        if (!allocation.grow(40 * MiB)) throw new HttpError(503, "body_capacity_exhausted", "Request capacity unavailable");
        this.active = current;
      });
      // Register the complete physical continuation before the prompt race.
      const work = this.acquire(selected, current);
      physical = work.then(() => undefined, () => undefined).then(() => {
        if (current.responses.some(response => response.body?.locked)) throw new Error("copilot_catalog_input_not_retired");
        current.responses.length = 0;
      });
      void physical.catch(() => undefined);
      const view = await operation.wait(work, "upstream");
      operation.signal.throwIfAborted();
      return this.reply(view, 200, physical, release, operation);
    } catch (error) {
      active?.operation.stop("upstream");
      if (request.body?.locked) physical = Promise.reject(new Error("copilot_catalog_control_not_retired"));
      const status = error instanceof HttpError ? error.status : 503;
      return this.reply({ error: { code: error instanceof HttpError ? error.code : "copilot_catalog_unavailable", message: "Copilot catalog unavailable" } }, status, physical, release);
    }
  }

  private async policy(selected: CopilotCatalogInput, operation: HttpOperation): Promise<AccessPolicy> {
    const authorization = selected.authorization;
    if (authorization.kind !== "public") throw unavailable();
    const policy = await authorizeResponseControl(this.env, authorization, {
      providerId: provider, endpointId: "models", grantKey: selected.key, lineage: selected.expectedLineage,
      routeSha256: await sha256Hex(JSON.stringify([provider, selected.key, selected.expectedGeneration, selected.expectedLineage, selected.accountAttemptId, selected.runtimeIdentity])),
      policyGeneration: authorization.binding.policyGeneration,
    }, operation.signal);
    operation.signal.throwIfAborted(); assertControlCallerLive(authorization);
    if (!policy) throw unavailable();
    // This private onboarding owner is not an active generic pool credential.
    // Direct policy/tenant scope only; shared/alternate owners are not inferred.
    const parts = selected.key.split("/"), tenant = parts[1] === "tenants";
    if (tenant ? parts[2] !== authorization.binding.tenantId : parts[1] !== authorization.binding.policyId) throw unavailable();
    const routing = grantRoutingPolicy(policy.grantRouting), tokenRef = parts[tenant ? 3 : 2];
    if (Object.hasOwn(routing.eligibleGrants, provider) && !routing.eligibleGrants[provider].includes(tokenRef)) throw unavailable();
    return policy;
  }

  private scope(record: CredentialRecord | undefined, selected: CopilotCatalogInput, original?: Scope): Scope {
    if (!record) throw unavailable();
    assertCopilotAccountRecord(record);
    const device = record.copilotDeviceAttempt, credential = record.copilotDeviceCredential;
    const attempt = record.copilotAccountAttempt, binding = record.copilotAccountBinding;
    if (record.grantKey !== selected.key || record.providerId !== provider || record.kind !== "oauth" || record.enabled !== true || record.revokedAt
      || record.status !== "reauth_required" || record.generation !== selected.expectedGeneration || record.lineage !== selected.expectedLineage
      || record.credential || record.credentials || record.accessToken || record.refreshToken || record.refreshAttempt
      || !device || device.version !== 1 || device.phase !== "committed" || device.id !== selected.deviceAttemptId || device.key !== selected.key
      || device.generation !== record.generation || device.lineage !== record.lineage
      || !credential || credential.version !== 1 || credential.githubDomain !== device.githubDomain || credential.ownerBinding !== device.ownerBinding
      || !credential.accessToken || credential.accessToken.length > 8192
      || !attempt || attempt.version !== 1 || attempt.phase !== "qualified" || attempt.id !== selected.accountAttemptId
      || !binding || binding.version !== 1 || binding.accountAttemptId !== attempt.id || binding.ownerBinding !== attempt.ownerBinding
      || binding.ownerBinding !== selected.runtimeIdentity.ownerBinding || binding.apiBaseUrl.length > 48 * 1024) throw unavailable();
    for (const current of [attempt, binding]) {
      if (current.key !== selected.key || current.generation !== record.generation || current.lineage !== record.lineage
        || current.deviceAttemptId !== device.id || current.acquisitionBinding !== credential.ownerBinding
        || current.githubDomain !== device.githubDomain || current.actor !== device.actor) throw unavailable();
    }
    if (original && (credential.accessToken !== original.token || binding.ownerBinding !== original.binding.ownerBinding
      || binding.apiBaseUrl !== original.binding.apiBaseUrl || binding.githubDomain !== original.binding.githubDomain)) throw unavailable();
    return { binding, token: credential.accessToken };
  }

  private async dispatch(selected: CopilotCatalogInput, active: Active, original: Scope | undefined, catalog: boolean): Promise<{ response: Promise<Response>; url: string; scope: Scope; policy: AccessPolicy }> {
    const { operation } = active;
    const policy = await this.policy(selected, operation);
    return this.owner.order(async () => {
      // The final original-owner read is the last await before fetch starts.
      const scope = this.scope(await this.owner.read(), selected, original);
      const request = catalog
        ? copilotCatalogRequest(scope.binding, scope.binding.ownerBinding, scope.token, selected.runtimeIdentity)
        : copilotAccountRequest(scope.binding.githubDomain, scope.token);
      // Also qualify the closed runtime identity BEFORE the first account GET.
      if (!catalog) copilotCatalogRequest(scope.binding, scope.binding.ownerBinding, scope.token, selected.runtimeIdentity);
      operation.signal.throwIfAborted(); assertControlCallerLive(selected.authorization);
      if (Date.now() >= selected.deadline) throw unavailable();
      let response: Promise<Response>;
      try { response = fetch(request, { signal: operation.signal, redirect: "manual" }); }
      catch (error) { response = Promise.reject(error); }
      return { response, url: request.url, scope, policy };
    });
  }

  private async response(pending: Promise<Response>, active: Active): Promise<Response> {
    const response = await pending;
    active.responses.push(response); // Both owners remain registered, never overwritten.
    if (active.operation.signal.aborted) {
      if (response.body && !response.bodyUsed && !response.body.locked) await inputRetirement(response.body.getReader()).retire("cancel", active.operation.signal.reason);
      active.operation.signal.throwIfAborted();
    }
    return response;
  }

  private async acquire(selected: CopilotCatalogInput, active: Active): Promise<CatalogView> {
    const { operation } = active;
    const account = await this.dispatch(selected, active, undefined, false);
    const accountResponse = await this.response(account.response, active);
    const projection = await readCopilotAccountResponse(accountResponse, { operation, expectedUrl: account.url });
    const identity = qualifyCopilotIdentity(projection, account.scope.binding.githubDomain, account.scope.binding.ownerBinding);
    if (identity.apiBaseUrl !== account.scope.binding.apiBaseUrl) throw unavailable();
    const admitted = account.policy;
    await this.policy(selected, operation);
    const catalog = await this.dispatch(selected, active, account.scope, true);
    const catalogResponse = await this.response(catalog.response, active);
    const text = await readCopilotResponseText(catalogResponse, { operation, expectedUrl: catalog.url, profile: "catalog" });
    const decoded = decodeCopilotModelCatalog(text);
    const policy = await this.policy(selected, operation);
    return this.owner.order(async () => {
      this.scope(await this.owner.read(), selected, account.scope);
      operation.signal.throwIfAborted(); assertControlCallerLive(selected.authorization);
      if (Date.now() >= selected.deadline) throw unavailable();
      const data = Object.freeze(decoded.data.filter(row => policyAllowsModel(admitted, provider, provider + "/" + row.id)
        && policyAllowsModel(policy, provider, provider + "/" + row.id)));
      const selection = selected.selection, row = selection && data.find(row => provider + "/" + row.id === selection.modelId);
      const verdict: CatalogView["selection"] = selection && row?.policy?.state === "enabled" && row.model_picker_enabled === true
        && copilotModelFormats(row).includes(selection.format)
        ? { eligible: true, modelId: selection.modelId, upstreamId: row.id, format: selection.format } : { eligible: false };
      return { version: "clawrouter.copilot-catalog.v1", observationId: crypto.randomUUID(), observedAt: Date.now(),
        generation: selected.expectedGeneration, lineage: selected.expectedLineage, accountAttemptId: selected.accountAttemptId,
        data, selection: verdict } satisfies CatalogView;
    });
  }

  private reply(value: unknown, status: number, physical: Promise<void>, release: () => void, operation?: HttpOperation): Response {
    const transport = jsonBodyTransport(value, status === 200 ? 4 * MiB : 2048), source = transport.stream();
    value = undefined;
    const reader = source.getReader(), owner = inputRetirement(reader);
    let ended!: () => void;
    const producer = new Promise<void>(resolve => { ended = resolve; });
    const retire = (kind: "eof" | "cancel", reason?: unknown) => owner.retire(kind, reason).then(() => { ended(); });
    let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const aborted = () => {
      outputController?.error(operation?.signal.reason);
      void retire("cancel", operation?.signal.reason).catch(() => undefined);
    };
    operation?.signal.addEventListener("abort", aborted, { once: true });
    const retained = Promise.all([physical, producer, owner.retired]).then(() => {
      operation?.signal.removeEventListener("abort", aborted);
      outputController = undefined; transport.discard(); operation?.stop("complete"); release();
    });
    this.owner.retain(retained); void retained.catch(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { outputController = controller; },
      async pull(controller) {
        try {
          operation?.signal.throwIfAborted();
          const next = await owner.read(() => reader.read());
          operation?.signal.throwIfAborted();
          if (next.done) { await retire("eof"); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { operation?.stop("publication", error); await retire("cancel", error); controller.error(error); }
      },
      cancel(reason) { operation?.cancel(reason); void retire("cancel", reason).catch(() => undefined); },
    }, { highWaterMark: 0 });
    if (operation?.signal.aborted) aborted();
    return new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "content-length": String(transport.bytes) } });
  }
}
