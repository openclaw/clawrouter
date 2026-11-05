import { copilotDeviceAdmin, readCopilotDeviceJson, copilotDeviceReply } from "./copilot-device-admin.ts";
import { accountConflict, copilotAccountHeaders, copilotAccountFailure, copilotAccountFlow, readCopilotAccountInput, type CopilotAccountInput } from "./copilot-account-admin.ts";
import { copilotAccountRequest, qualifyCopilotIdentity, type CopilotIdentity } from "./provider-copilot.ts";
import { readCopilotAccountResponse } from "./copilot-account-response.ts";
import { inputRetirement } from "./input-retirement.ts";
import { HttpOperation } from "./http-operation.ts";
import { BodyLease } from "./body-budget.ts";
import { HttpError, sha256Hex } from "./utils.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import type { Env } from "./types.ts";

interface AccountScope {
  key: string; generation: number; lineage: string; deviceAttemptId: string;
  acquisitionBinding: string; githubDomain: string; actor: string;
}
export interface CopilotAccountAttempt extends AccountScope {
  version: 1; id: string; ownerBinding: string;
  phase: "dispatch_unknown" | "qualified" | "cancelled" | "unknown";
}
export interface CopilotAccountBinding extends AccountScope, CopilotIdentity {
  version: 1; accountAttemptId: string; qualifiedAt: number;
}
export interface CopilotAccountOwner {
  order<T>(run: () => Promise<T>): Promise<T>;
  read(): Promise<CredentialRecord | undefined>;
  save(record: CredentialRecord): Promise<void>;
  publish(record: CredentialRecord): Promise<void>;
  retain(work: Promise<void>): void;
  invalidateCatalog?(): void;
}
type Exchange = { attempt: CopilotAccountAttempt; operation: HttpOperation; work: Promise<void>; response?: Response; identity?: CopilotIdentity };

// Bound the predecessor graph BEFORE stringify/encoding. This private row has
// no arrays, accessors, toJSON hooks or unbounded discarded metadata. Counts and
// escaped UTF-8 size include keys and all copies of the small account scope.
export function assertCopilotAccountRecord(record: CredentialRecord): void {
  let nodes = 0, members = 0, bytes = 0;
  const add = (n: number) => { bytes += n; if (bytes > 96 * 1024) throw accountConflict(); };
  const string = (s: string) => {
    add(2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(2);
      else if (c < 32) add(6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (c >= 0xd800 && c <= 0xdfff) {
        if (c <= 0xdbff && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
        else add(6);
      } else add(3);
    }
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 128 || depth > 6) throw accountConflict();
    if (value === null) { add(4); return; }
    if (typeof value === "string") { string(value); return; }
    if (typeof value === "boolean") { add(value ? 4 : 5); return; }
    if (typeof value === "number" && Number.isFinite(value)) { add(String(value).length); return; }
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw accountConflict();
    add(2); let comma = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++members > 128 || key.length > 64) throw accountConflict();
      const field = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(field, "value")) throw accountConflict();
      if (field.value === undefined) continue;
      if (comma) add(1); comma = true; string(key); add(1); visit(field.value, depth + 1);
    }
  };
  visit(record, 0);
}

export class CopilotAccountFlow {
  private inFlight?: Exchange;
  private readonly owner: CopilotAccountOwner;
  private readonly env: Env;
  constructor(owner: CopilotAccountOwner, env: Env) { this.owner = owner; this.env = env; }

  // Called while the credential owner's ordering tail is held. Never wait for
  // remote work here: its own retirement continuation retains the allocation.
  async invalidate(): Promise<void> {
    this.owner.invalidateCatalog?.();
    this.inFlight?.operation.stop("caller");
    const record = await this.owner.read();
    if (record?.copilotAccountAttempt) {
      record.copilotAccountAttempt = { ...record.copilotAccountAttempt, phase: "cancelled" };
      delete record.copilotAccountBinding;
      await this.owner.save(record);
    }
  }

  async fetch(internal: Request): Promise<Response> {
    const lease = new BodyLease(); let physical = Promise.resolve();
    const reply = (value: unknown, status = 200) => copilotDeviceReply(value, status, lease, physical, work => this.owner.retain(work));
    try {
      if (!lease.grow(1024 * 1024)) throw new HttpError(503, "body_capacity_exhausted", "Request capacity unavailable");
      const body = await readCopilotDeviceJson(internal) as { key?: unknown; sourceUrl?: unknown; input?: unknown };
      if (!body || typeof body !== "object" || Object.keys(body).some(k => !["key", "sourceUrl", "input"].includes(k))
        || typeof body.key !== "string" || body.key.length > 512 || !/^oauth\/(?:tenants\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(body.key)
        || typeof body.sourceUrl !== "string" || body.sourceUrl.length > 2048) throw accountConflict();
      const key = body.key, input = readCopilotAccountInput(body.input), source = new URL(body.sourceUrl);
      const route = key.startsWith("oauth/tenants/") ? "tenants/" + key.slice(14) : "policies/" + key.slice(6);
      if (source.pathname !== `/v1/admin/upstream-grants/${route}/authorize` || source.searchParams.size !== 1
        || source.searchParams.get("flow") !== copilotAccountFlow) throw accountConflict();
      const request = new Request(source, { method: "POST", headers: copilotAccountHeaders(internal.headers), signal: internal.signal });
      const actor = await copilotDeviceAdmin(request, this.env);
      const reserved = await this.owner.order(async () => {
        await copilotDeviceAdmin(request, this.env, actor);
        const record = await this.owner.read();
        const scope = this.scope(record, key, input, actor);
        let attempt = record!.copilotAccountAttempt;
        if (attempt) {
          this.assertAttempt(scope, attempt);
          if (input.operation === "cancel") {
            this.owner.invalidateCatalog?.();
            this.inFlight?.operation.stop("caller");
            attempt = record!.copilotAccountAttempt = { ...attempt, phase: "cancelled" };
            delete record!.copilotAccountBinding; await this.owner.save(record!);
          } else if (attempt.phase === "dispatch_unknown" && (!this.inFlight || this.inFlight.attempt.id !== attempt.id)) {
            attempt = record!.copilotAccountAttempt = { ...attempt, phase: "unknown" }; await this.owner.save(record!);
          }
          if (attempt.phase === "qualified") {
            this.assertBinding(record!, attempt);
            await this.owner.publish(record!);
            await copilotDeviceAdmin(request, this.env, actor);
          }
          return { view: this.view(record!, attempt) };
        }
        if (input.operation !== "qualify") throw accountConflict();
        // Independent account operational reservation: not device allocation
        // evidence. No durable fence or HTTP before this atomic verdict.
        if (!lease.grow(32 * 1024 * 1024)) throw new HttpError(503, "body_capacity_exhausted", "Request capacity unavailable");
        const ownerBinding = await sha256Hex(JSON.stringify([key, scope.generation, scope.lineage, scope.deviceAttemptId, scope.acquisitionBinding, scope.githubDomain]));
        attempt = { ...scope, version: 1, id: crypto.randomUUID(), ownerBinding, phase: "dispatch_unknown" };
        record!.copilotAccountAttempt = attempt; await this.owner.save(record!);
        await copilotDeviceAdmin(request, this.env, actor);
        const fresh = await this.owner.read(); this.assertAttempt(this.scope(fresh, key, input, actor), attempt);
        if (fresh?.copilotAccountAttempt?.id !== attempt.id || fresh.copilotAccountAttempt.phase !== "dispatch_unknown") throw accountConflict();
        await copilotDeviceAdmin(request, this.env, actor);
        // The token goes only to the fixed account factory, never into context,
        // public metadata, an alternate owner or a generic credential slot.
        return { exchange: this.start(request, attempt, fresh.copilotDeviceCredential!.accessToken) };
      });
      if ("view" in reserved) return reply(reserved.view);
      const exchange = reserved.exchange;
      let settle!: () => void;
      const settled = new Promise<void>(resolve => { settle = resolve; });
      physical = exchange.work.catch(() => undefined).then(async () => {
        await settled;
        if (exchange.response?.body?.locked) throw new Error("copilot_account_input_not_retired");
        exchange.identity = undefined; exchange.response = undefined;
        if (this.inFlight === exchange) this.inFlight = undefined;
      });
      void physical.catch(() => undefined);
      try {
        // Only this whole-operation race is prompt. The account reader itself
        // joins actual physical reads and FIRST cleanup before it settles.
        await exchange.operation.wait(exchange.work, "upstream");
        const view = await this.owner.order(async () => {
          await copilotDeviceAdmin(request, this.env, actor); exchange.operation.signal.throwIfAborted();
          const current = await this.owner.read();
          this.assertAttempt(this.scope(current, key, input, actor), exchange.attempt);
          if (current?.copilotAccountAttempt?.id !== exchange.attempt.id || current.copilotAccountAttempt.phase !== "dispatch_unknown") throw accountConflict();
          const identity = exchange.identity!;
          if (identity.ownerBinding !== exchange.attempt.ownerBinding || identity.githubDomain !== exchange.attempt.githubDomain) throw accountConflict();
          const { id: accountAttemptId, phase: _phase, ...scope } = exchange.attempt;
          current.copilotAccountBinding = { ...scope, ...identity, version: 1, accountAttemptId, qualifiedAt: Date.now() };
          current.copilotAccountAttempt = { ...exchange.attempt, phase: "qualified" };
          // Generation is unchanged: account observation is not token rotation,
          // token expiry, catalog entitlement or inference activation.
          await copilotDeviceAdmin(request, this.env, actor); exchange.operation.signal.throwIfAborted();
          await this.owner.save(current); // binding AND terminal attempt, one row
          await copilotDeviceAdmin(request, this.env, actor); exchange.operation.signal.throwIfAborted();
          await this.owner.publish(current);
          await copilotDeviceAdmin(request, this.env, actor);
          return this.view(current, current.copilotAccountAttempt);
        });
        return reply(view);
      } catch {
        exchange.operation.stop("upstream");
        return reply(await this.owner.order(async () => {
          await copilotDeviceAdmin(request, this.env, actor);
          const current = await this.owner.read(); this.assertAttempt(this.scope(current, key, input, actor), exchange.attempt);
          const attempt = current!.copilotAccountAttempt;
          if (!attempt || attempt.id !== exchange.attempt.id) throw accountConflict();
          if (attempt.phase === "qualified") throw new HttpError(503, "copilot_account_publication_pending", "Account publication is pending");
          if (attempt.phase === "dispatch_unknown") {
            current!.copilotAccountAttempt = { ...attempt, phase: "unknown" }; delete current!.copilotAccountBinding;
            await this.owner.save(current!);
          }
          return this.view(current!, current!.copilotAccountAttempt!);
        }));
      } finally { exchange.operation.stop("complete"); settle(); }
    } catch (error) {
      if (internal.body?.locked) physical = Promise.reject(new Error("copilot_account_input_not_retired"));
      const failure = copilotAccountFailure(error); return reply(failure.value, failure.status);
    }
  }

  private start(request: Request, attempt: CopilotAccountAttempt, token: string): Exchange {
    const descriptor = copilotAccountRequest(attempt.githubDomain, token);
    request.signal.throwIfAborted();
    const operation = new HttpOperation(request.signal, 30_000);
    const exchange: Exchange = { attempt, operation, work: Promise.resolve() }; this.inFlight = exchange;
    let pending: Promise<Response>;
    try { pending = fetch(descriptor, { signal: operation.signal, redirect: "manual" }); }
    catch (error) { pending = Promise.reject(error); }
    const expectedUrl = descriptor.url;
    exchange.work = pending.then(async response => {
      exchange.response = response;
      if (operation.signal.aborted) {
        if (response.body && !response.bodyUsed && !response.body.locked) await inputRetirement(response.body.getReader()).retire("cancel", operation.signal.reason);
        operation.signal.throwIfAborted();
      }
      const projection = await readCopilotAccountResponse(response, { operation, expectedUrl });
      // Projection contains only the bounded API field, never the 16 MiB body.
      const identity = qualifyCopilotIdentity(projection, attempt.githubDomain, attempt.ownerBinding);
      if (identity.apiBaseUrl.length > 48 * 1024 || new TextEncoder().encode(identity.apiBaseUrl).byteLength > 48 * 1024) throw accountConflict();
      operation.signal.throwIfAborted(); exchange.identity = identity;
    });
    void exchange.work.catch(() => undefined);
    return exchange;
  }

  private scope(record: CredentialRecord | undefined, key: string, input: CopilotAccountInput, actor: string): AccountScope {
    if (!record) throw accountConflict();
    assertCopilotAccountRecord(record);
    const device = record.copilotDeviceAttempt, credential = record.copilotDeviceCredential;
    if (record.grantKey !== key || record.providerId !== "github-copilot" || record.kind !== "oauth" || !record.enabled || record.revokedAt
      || record.status !== "reauth_required" || record.generation !== input.expectedGeneration || record.lineage !== input.expectedLineage
      || record.refreshAttempt || record.credential || record.accessToken || record.refreshToken
      || !device || device.phase !== "committed" || device.id !== input.attemptId || device.key !== key || device.actor !== actor
      || device.generation !== record.generation || device.lineage !== record.lineage
      || !credential || credential.version !== 1 || credential.githubDomain !== device.githubDomain || credential.ownerBinding !== device.ownerBinding
      || !credential.accessToken || credential.accessToken.length > 8192) throw accountConflict();
    return { key, generation: record.generation, lineage: record.lineage, deviceAttemptId: device.id,
      acquisitionBinding: credential.ownerBinding, githubDomain: credential.githubDomain, actor };
  }
  private assertAttempt(scope: AccountScope, attempt: CopilotAccountAttempt) {
    for (const key of ["key", "generation", "lineage", "deviceAttemptId", "acquisitionBinding", "githubDomain", "actor"] as const)
      if (scope[key] !== attempt[key]) throw accountConflict();
  }
  private assertBinding(record: CredentialRecord, attempt: CopilotAccountAttempt) {
    const binding = record.copilotAccountBinding;
    if (!binding || binding.version !== 1 || binding.accountAttemptId !== attempt.id || binding.ownerBinding !== attempt.ownerBinding) throw accountConflict();
    this.assertAttempt(binding, attempt);
  }
  private view(record: CredentialRecord, attempt: CopilotAccountAttempt) {
    if (attempt.phase === "qualified") this.assertBinding(record, attempt);
    return { attemptId: attempt.deviceAttemptId, accountAttemptId: attempt.id, status: attempt.phase === "dispatch_unknown" ? "qualifying" : attempt.phase,
      qualifiedAt: attempt.phase === "qualified" ? record.copilotAccountBinding!.qualifiedAt : null };
  }
}
