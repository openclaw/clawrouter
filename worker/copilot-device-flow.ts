import { prepareCopilotDeviceRequest, decodeCopilotDeviceAuthorization, prepareCopilotDevicePollRequest, decodeCopilotDevicePoll,
  type CopilotDeviceAuthorization, type CopilotDevicePollResult, type CopilotDevicePost } from "./provider-copilot-device.ts";
import { copilotDeviceAdmin, readCopilotDeviceInput, readCopilotDeviceJson, copilotDeviceReply, copilotDeviceFailure, type CopilotDeviceInput } from "./copilot-device-admin.ts";
import { readCopilotResponseText } from "./copilot-response-body.ts";
import { inputRetirement } from "./input-retirement.ts";
import { HttpOperation } from "./http-operation.ts";
import { BodyLease } from "./body-budget.ts";
import { HttpError, sha256Hex } from "./utils.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import type { Env } from "./types.ts";

type Phase = "begin_unknown" | "poll_unknown" | "pending" | "committed" | "cancelled" | "expired" | "denied" | "unknown" | "failed";
export interface CopilotDeviceAttempt {
  version: 1; id: string; intentId: string; actor: string; key: string; githubDomain: string;
  generation: number; lineage: string; ownerBinding: string; phase: Phase;
  expiresAt: number; nextPollAt: number; intervalMs: number;
  authorization?: CopilotDeviceAuthorization;
}
// Acquired, not an inference credential. No generic accessToken or expiry is
// created; account qualification and materialization remain separate work.
export interface CopilotDeviceCredential {
  version: 1; githubDomain: string; ownerBinding: string; accessToken: string;
}
export interface CopilotDeviceOwner {
  order<T>(run: () => Promise<T>): Promise<T>;
  read(): Promise<CredentialRecord | undefined>;
  save(record: CredentialRecord): Promise<void>;
  begin(key: string, input: Extract<CopilotDeviceInput, { operation: "begin" }>): Promise<CredentialRecord>;
  install(record: CredentialRecord, token: CopilotDeviceCredential, revalidate: () => Promise<void>): Promise<CredentialRecord>;
  publish(record: CredentialRecord): Promise<void>;
  retain(work: Promise<void>): void;
}
type Result = CopilotDeviceAuthorization | CopilotDevicePollResult;
type Exchange = { id: string; operation: HttpOperation; startedAt: number; work: Promise<void>; response?: Response; result?: Result };
const active = (phase: Phase) => phase === "begin_unknown" || phase === "poll_unknown";
const terminal = (attempt: CopilotDeviceAttempt, phase: Phase): CopilotDeviceAttempt => ({ ...attempt, phase, authorization: undefined });
const conflict = () => new HttpError(409, "copilot_device_conflict", "Device attempt or credential owner changed");

export class CopilotDeviceFlow {
  private inFlight?: Exchange;
  private readonly owner: CopilotDeviceOwner;
  private readonly env: Env;
  constructor(owner: CopilotDeviceOwner, env: Env) { this.owner = owner; this.env = env; }

  async invalidate(): Promise<void> {
    this.inFlight?.operation.stop("caller");
    const record = await this.owner.read(), attempt = record?.copilotDeviceAttempt;
    if (record && attempt && ["pending", "begin_unknown", "poll_unknown", "unknown"].includes(attempt.phase))
      await this.owner.save({ ...record, copilotDeviceAttempt: terminal(attempt, "cancelled") });
  }

  async fetch(internal: Request): Promise<Response> {
    const lease = new BodyLease(); let physical = Promise.resolve();
    const reply = (value: unknown, status = 200) => copilotDeviceReply(value, status, lease, physical, work => this.owner.retain(work));
    try {
      if (!lease.grow(1024 * 1024)) throw new HttpError(503, "body_capacity_exhausted", "Request capacity unavailable");
      const body = await readCopilotDeviceJson(internal) as { key?: unknown; sourceUrl?: unknown; input?: unknown };
      if (!body || typeof body !== "object" || Object.keys(body).some(k => !["key", "sourceUrl", "input"].includes(k))
        || typeof body.key !== "string" || !/^oauth\/(?:tenants\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(body.key)
        || typeof body.sourceUrl !== "string" || body.sourceUrl.length > 2048) throw conflict();
      const input = readCopilotDeviceInput(body.input), key = body.key;
      const source = new URL(body.sourceUrl);
      const route = key.startsWith("oauth/tenants/") ? "tenants/" + key.slice(14) : "policies/" + key.slice(6);
      if (source.pathname !== `/v1/admin/upstream-grants/${route}/authorize` || source.searchParams.size !== 1
        || source.searchParams.get("flow") !== "copilot-device.v1") throw conflict();
      const request = new Request(source, { method: "POST", headers: internal.headers, signal: internal.signal });
      const actor = await copilotDeviceAdmin(request, this.env);
      const reserve = () => { if (!lease.grow(32 * 1024 * 1024)) throw new HttpError(503, "body_capacity_exhausted", "Request capacity unavailable"); };
      const reserved = await this.owner.order(async () => {
        await copilotDeviceAdmin(request, this.env, actor);
        let record = await this.owner.read(), attempt = record?.copilotDeviceAttempt;
        if (input.operation === "begin") {
          if (attempt?.intentId === input.intentId) {
            if (attempt.actor !== actor || attempt.key !== key || attempt.githubDomain !== input.githubDomain) throw conflict();
            return { view: await this.recover(record!, attempt) };
          }
          if (attempt && (input.replacesAttemptId !== attempt.id || attempt.actor !== actor
            || ["pending", "begin_unknown", "poll_unknown"].includes(attempt.phase)
            || attempt.phase === "unknown" && record?.generation === attempt.generation)) throw conflict();
          if (!attempt && input.replacesAttemptId !== undefined) throw conflict();
          reserve(); record = await this.owner.begin(key, input);
          const ownerBinding = await sha256Hex(JSON.stringify([key, record.lineage, record.generation, input.githubDomain]));
          attempt = { version: 1, id: crypto.randomUUID(), intentId: input.intentId, actor, key, githubDomain: input.githubDomain,
            ownerBinding, generation: record.generation, lineage: record.lineage!, phase: "begin_unknown",
            expiresAt: Date.now() + 30_000, nextPollAt: 0, intervalMs: 5000 };
          record.copilotDeviceAttempt = attempt;
          const descriptor = prepareCopilotDeviceRequest({ githubDomain: attempt.githubDomain, ownerBinding }, ownerBinding);
          await this.owner.save(record); await this.owner.publish(record);
          await copilotDeviceAdmin(request, this.env, actor);
          return this.start(request, attempt, descriptor);
        }
        if (!record || !attempt || input.attemptId !== attempt.id || actor !== attempt.actor || key !== attempt.key) throw conflict();
        this.assertOwner(record, attempt);
        if (input.operation === "cancel") {
          if (attempt.phase !== "committed") {
            this.inFlight?.operation.stop("caller");
            record.copilotDeviceAttempt = terminal(attempt, "cancelled"); await this.owner.save(record);
          }
          return { view: this.view(record.copilotDeviceAttempt!) };
        }
        if (input.operation === "status" || attempt.phase !== "pending") return { view: await this.recover(record, attempt) };
        if (Date.now() >= attempt.expiresAt) {
          record.copilotDeviceAttempt = terminal(attempt, "expired"); await this.owner.save(record);
          return { view: this.view(record.copilotDeviceAttempt) };
        }
        if (Date.now() < attempt.nextPollAt) throw new HttpError(409, "copilot_device_poll_early", "Device poll interval has not elapsed");
        reserve();
        const descriptor = prepareCopilotDevicePollRequest(attempt.authorization!, attempt.ownerBinding);
        record.copilotDeviceAttempt = { ...attempt, phase: "poll_unknown" }; await this.owner.save(record);
        await copilotDeviceAdmin(request, this.env, actor);
        return this.start(request, record.copilotDeviceAttempt, descriptor);
      });
      if ("view" in reserved) return reply(reserved.view);
      const { exchange, attempt } = reserved;
      // Registered before racing cancellation. Late responses are disposed by
      // this same work, and a completed reader includes its FIRST cleanup.
      // Result retirement must follow consumption/installation, not merely
      // HTTP EOF. Resolve this phase only after settlement relinquishes it.
      let settle!: () => void;
      const settled = new Promise<void>(resolve => { settle = resolve; });
      physical = exchange.work.catch(() => undefined).then(async () => {
        await settled;
        if (exchange.response?.body?.locked) throw new Error("copilot_device_input_not_retired");
        exchange.result = undefined; exchange.response = undefined;
        if (this.inFlight === exchange) this.inFlight = undefined;
      });
      void physical.catch(() => undefined);
      try {
        await exchange.operation.wait(exchange.work, "upstream");
        const view = await this.owner.order(async () => {
          await copilotDeviceAdmin(request, this.env, actor); exchange.operation.signal.throwIfAborted();
          const current = await this.owner.read();
          if (!current || current.copilotDeviceAttempt?.id !== attempt.id || current.copilotDeviceAttempt.phase !== attempt.phase) throw conflict();
          this.assertOwner(current, attempt);
          const result = exchange.result!;
          if (Date.now() >= attempt.expiresAt) {
            current.copilotDeviceAttempt = terminal(attempt, "expired"); await this.owner.save(current);
          } else if ("verificationUrl" in result) {
            const expiresAt = exchange.startedAt + result.expiresInMs, nextPollAt = Date.now() + result.intervalMs;
            if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(nextPollAt) || expiresAt <= Date.now()) throw conflict();
            current.copilotDeviceAttempt = { ...attempt, phase: "pending", authorization: result, expiresAt, nextPollAt, intervalMs: result.intervalMs };
            await this.owner.save(current);
          } else if (result.status === "pending") {
            const nextPollAt = Date.now() + result.intervalMs;
            if (!Number.isSafeInteger(nextPollAt)) throw conflict();
            current.copilotDeviceAttempt = { ...attempt, phase: "pending", intervalMs: result.intervalMs, nextPollAt };
            await this.owner.save(current);
          } else if (result.status === "authorized") {
            const installed = await this.owner.install(current, { version: 1, githubDomain: result.githubDomain, ownerBinding: result.ownerBinding, accessToken: result.accessToken }, async () => {
              await copilotDeviceAdmin(request, this.env, actor); exchange.operation.signal.throwIfAborted();
            });
            await this.owner.publish(installed); return this.view(installed.copilotDeviceAttempt!);
          } else {
            current.copilotDeviceAttempt = terminal(attempt, result.status === "access_denied" ? "denied" : result.status === "expired" ? "expired" : "failed");
            await this.owner.save(current);
          }
          return this.view(current.copilotDeviceAttempt!);
        });
        return reply(view);
      } catch {
        exchange.operation.stop("upstream");
        return reply(await this.owner.order(async () => {
          const current = await this.owner.read(), present = current?.copilotDeviceAttempt;
          if (!current || !present || present.id !== attempt.id) throw conflict();
          this.assertOwner(current, present);
          if (active(present.phase)) { current.copilotDeviceAttempt = terminal(present, "unknown"); await this.owner.save(current); }
          await copilotDeviceAdmin(request, this.env, actor);
          return this.view(current.copilotDeviceAttempt!);
        }));
      } finally { exchange.operation.stop("complete"); settle(); }
    } catch (error) {
      if (internal.body?.locked) physical = Promise.reject(new Error("copilot_device_input_not_retired"));
      const failure = copilotDeviceFailure(error); return reply(failure.value, failure.status);
    }
  }

  private start(request: Request, attempt: CopilotDeviceAttempt, descriptor: CopilotDevicePost) {
    request.signal.throwIfAborted();
    if (Date.now() >= attempt.expiresAt) throw conflict();
    const startedAt = Date.now(), operation = new HttpOperation(request.signal, Math.min(30_000, attempt.expiresAt - startedAt));
    const exchange: Exchange = { id: attempt.id, operation, startedAt, work: Promise.resolve() };
    this.inFlight = exchange;
    // A synchronous fetch failure is uncertain too: keep the persisted fence
    // and send it through the same settlement/retirement path.
    let pending: Promise<Response>;
    try { pending = fetch(descriptor.url, { ...descriptor.init, signal: operation.signal, redirect: "manual" }); }
    catch (error) { pending = Promise.reject(error); }
    exchange.work = pending.then(async response => {
      exchange.response = response;
      if (operation.signal.aborted) {
        if (response.body && !response.bodyUsed && !response.body.locked) await inputRetirement(response.body.getReader()).retire("cancel", operation.signal.reason);
        operation.signal.throwIfAborted();
      }
      const text = await readCopilotResponseText(response, { operation, expectedUrl: descriptor.url, profile: "device" });
      exchange.result = attempt.phase === "begin_unknown"
        ? decodeCopilotDeviceAuthorization(text, response.status, { githubDomain: attempt.githubDomain, ownerBinding: attempt.ownerBinding }, attempt.ownerBinding)
        : decodeCopilotDevicePoll(text, response.status, attempt.authorization!, attempt.ownerBinding, attempt.intervalMs);
    });
    void exchange.work.catch(() => undefined);
    return { exchange, attempt };
  }

  private assertOwner(record: CredentialRecord, attempt: CopilotDeviceAttempt): void {
    if (record.generation !== attempt.generation || record.lineage !== attempt.lineage || record.grantKey !== attempt.key
      || record.providerId !== "github-copilot" || !record.enabled || record.revokedAt) throw conflict();
  }
  private async recover(record: CredentialRecord, attempt: CopilotDeviceAttempt) {
    this.assertOwner(record, attempt);
    if (active(attempt.phase) && (this.inFlight?.id !== attempt.id || this.inFlight.operation.signal.aborted)) {
      record.copilotDeviceAttempt = terminal(attempt, "unknown"); await this.owner.save(record);
    } else if (attempt.phase === "pending" && Date.now() >= attempt.expiresAt) {
      record.copilotDeviceAttempt = terminal(attempt, "expired"); await this.owner.save(record);
    }
    if (record.copilotDeviceAttempt?.phase === "committed") await this.owner.publish(record);
    return this.view(record.copilotDeviceAttempt!);
  }
  private view(attempt: CopilotDeviceAttempt) {
    return { attemptId: attempt.id, status: attempt.phase === "begin_unknown" ? "starting" : attempt.phase === "poll_unknown" ? "polling" : attempt.phase,
      expiresAt: attempt.expiresAt, nextPollAt: attempt.phase === "pending" ? attempt.nextPollAt : null,
      ...(attempt.phase === "pending" && attempt.authorization ? { userCode: attempt.authorization.userCode, verificationUri: attempt.authorization.verificationUrl } : {}) };
  }
}
