import { createMiniMaxDeviceSession, prepareMiniMaxDeviceRequest, decodeMiniMaxDeviceAuthorization,
  prepareMiniMaxTokenRequest, decodeMiniMaxTokenResponse,
  type MiniMaxDeviceSession, type MiniMaxDeviceAuthorization, type MiniMaxOAuthCredential } from "./provider-minimax-oauth.ts";
import { miniMaxDeviceAdmin, readMiniMaxDeviceInput, type MiniMaxDeviceInput } from "./minimax-device-admin.ts";
import { readMiniMaxTokenBody } from "./minimax-token-body.ts";
import { HttpOperation } from "./http-operation.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import type { Env } from "./types.ts";
import { HttpError, privateJson, readJson } from "./utils.ts";

type Phase = "begin_unknown" | "poll_unknown" | "pending" | "committed" | "cancelled" | "expired" | "unknown" | "failed";
export interface MiniMaxDeviceAttempt {
  version: 1; id: string; intentId: string; actor: string; key: string; region: "global" | "cn";
  generation: number; lineage: string; phase: Phase; expiresAt: number; nextPollAt: number;
  session?: MiniMaxDeviceSession; authorization?: MiniMaxDeviceAuthorization;
}
type Begin = Extract<MiniMaxDeviceInput, { operation: "begin" }>;
export interface MiniMaxDeviceOwner {
  order<T>(run: () => Promise<T>): Promise<T>;
  read(): Promise<CredentialRecord | undefined>;
  save(record: CredentialRecord): Promise<void>;
  begin(key: string, input: Begin): Promise<CredentialRecord>;
  install(record: CredentialRecord, credential: MiniMaxOAuthCredential, revalidate: () => Promise<void>): Promise<CredentialRecord>;
  publish(record: CredentialRecord): Promise<void>;
}

const active = (phase: Phase) => phase === "begin_unknown" || phase === "poll_unknown";
const terminal = (attempt: MiniMaxDeviceAttempt, phase: Phase): MiniMaxDeviceAttempt =>
  ({ ...attempt, phase, session: undefined, authorization: undefined });
function conflict(): never { throw new HttpError(409, "minimax_device_conflict", "Device attempt or credential generation changed"); }

// One bounded private attempt on the existing credential row. Only reservation
// and settlement occupy the owner's tail; remote I/O never holds that tail.
export class MiniMaxDeviceFlow {
  private owner: MiniMaxDeviceOwner;
  private env: Env;
  private inFlight?: { id: string; operation: HttpOperation };
  constructor(owner: MiniMaxDeviceOwner, env: Env) { this.owner = owner; this.env = env; }

  async invalidate(): Promise<void> {
    this.inFlight?.operation.stop("caller");
    const record = await this.owner.read(), attempt = record?.minimaxDeviceAttempt;
    if (record && attempt && ["pending", "begin_unknown", "poll_unknown", "unknown"].includes(attempt.phase))
      await this.owner.save({ ...record, minimaxDeviceAttempt: terminal(attempt, "cancelled") });
  }

  async fetch(internal: Request): Promise<Response> {
    try {
      const body = await readJson<{ key: string; sourceUrl: string; input: Record<string, unknown> }>(internal, undefined, 16 * 1024);
      const input = readMiniMaxDeviceInput(body.input);
      if (typeof body.key !== "string" || !/^oauth\/(?:tenants\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(body.key)) conflict();
      const request = new Request(body.sourceUrl, { method: "POST", headers: internal.headers, signal: internal.signal });
      const actor = await miniMaxDeviceAdmin(request, this.env);
      const reserved = await this.owner.order(async () => {
        await miniMaxDeviceAdmin(request, this.env, actor);
        let record = await this.owner.read(), attempt = record?.minimaxDeviceAttempt;
        if (input.operation === "begin") {
          if (attempt?.intentId === input.intentId) {
            if (attempt.actor !== actor || attempt.key !== body.key || attempt.region !== input.region) conflict();
            return { view: await this.recover(record!, attempt) };
          }
          if (attempt && (input.replacesAttemptId !== attempt.id || attempt.actor !== actor
            || ["pending", "begin_unknown", "poll_unknown"].includes(attempt.phase)
            || attempt.phase === "unknown" && record?.generation === attempt.generation)) conflict();
          if (!attempt && input.replacesAttemptId !== undefined) conflict();
          record = await this.owner.begin(body.key, input);
          const session = createMiniMaxDeviceSession(input.region, `${body.key}:${record.lineage}:${record.generation}`);
          const descriptor = await prepareMiniMaxDeviceRequest(session, session.ownerBinding);
          await miniMaxDeviceAdmin(request, this.env, actor);
          attempt = { version: 1, id: crypto.randomUUID(), intentId: input.intentId, actor, key: body.key, region: input.region,
            generation: record.generation, lineage: record.lineage!, phase: "begin_unknown", expiresAt: Date.now() + 15 * 60_000,
            nextPollAt: 0, session };
          record.minimaxDeviceAttempt = attempt;
          await this.owner.save(record); // fence and owner intent are one durable write
          await this.owner.publish(record);
          await miniMaxDeviceAdmin(request, this.env, actor);
          return this.start(request, record, descriptor);
        }
        if (!record || !attempt || input.attemptId !== attempt.id || actor !== attempt.actor || attempt.key !== body.key) conflict();
        this.assertOwner(record, attempt);
        if (input.operation === "cancel") {
          if (attempt.phase !== "committed") {
            this.inFlight?.operation.stop("caller");
            record = { ...record, minimaxDeviceAttempt: terminal(attempt, "cancelled") };
            await this.owner.save(record);
          }
          return { view: this.view(record.minimaxDeviceAttempt!) };
        }
        if (input.operation === "status" || attempt.phase !== "pending") return { view: await this.recover(record, attempt) };
        if (Date.now() >= attempt.expiresAt) {
          record.minimaxDeviceAttempt = terminal(attempt, "expired"); await this.owner.save(record);
          return { view: this.view(record.minimaxDeviceAttempt) };
        }
        if (Date.now() < attempt.nextPollAt) throw new HttpError(409, "minimax_device_poll_early", "Device poll interval has not elapsed");
        const descriptor = prepareMiniMaxTokenRequest(attempt.session!, attempt.authorization!, attempt.session!.ownerBinding, Date.now());
        record = { ...record, minimaxDeviceAttempt: { ...attempt, phase: "poll_unknown" } };
        await this.owner.save(record);
        await miniMaxDeviceAdmin(request, this.env, actor);
        return this.start(request, record, descriptor);
      });
      if ("view" in reserved) return privateJson(reserved.view);
      const { record, operation, response } = reserved;
      const attempt = record.minimaxDeviceAttempt!;
      try {
        const upstream = await operation.wait(response, "upstream", value => { void value.body?.cancel().catch(() => undefined); });
        const text = await operation.wait(readMiniMaxTokenBody(upstream, operation.signal), "upstream");
        const result = attempt.phase === "begin_unknown"
          ? decodeMiniMaxDeviceAuthorization(text, upstream.status, attempt.session!, attempt.session!.ownerBinding, Date.now())
          : decodeMiniMaxTokenResponse(text, upstream.status, attempt.region, attempt.session!.ownerBinding, Date.now());
        // The codec also labels unspecified non-success statuses pending. The
        // owner permits another exchange only for the qualified native literal;
        // slow_down, missing status and future statuses never become retries.
        if ("status" in result && result.status === "pending" && JSON.parse(text).status !== "pending")
          throw new Error("unqualified_minimax_pending_status");
        const view = await this.owner.order(async () => {
          await miniMaxDeviceAdmin(request, this.env, actor);
          operation.signal.throwIfAborted();
          const current = await this.owner.read();
          if (!current || current.minimaxDeviceAttempt?.id !== attempt.id || current.minimaxDeviceAttempt.phase !== attempt.phase) conflict();
          this.assertOwner(current, attempt);
          if (Date.now() >= attempt.expiresAt) {
            current.minimaxDeviceAttempt = terminal(attempt, "expired"); await this.owner.save(current);
          } else if ("verificationUrl" in result) {
            current.minimaxDeviceAttempt = { ...attempt, phase: "pending", authorization: result,
              expiresAt: Math.min(attempt.expiresAt, result.expiresAt), nextPollAt: Date.now() + Math.max(2000, result.intervalMs) };
            await this.owner.save(current);
          } else if (result.status === "pending") {
            current.minimaxDeviceAttempt = { ...attempt, phase: "pending", nextPollAt: Date.now() + Math.max(2000, attempt.authorization!.intervalMs) };
            await this.owner.save(current);
          } else if (result.status === "success") {
            // install commits the terminal attempt AND credential in one write.
            const installed = await this.owner.install(current, result.credential, async () => {
              await miniMaxDeviceAdmin(request, this.env, actor); operation.signal.throwIfAborted();
            });
            await this.owner.publish(installed);
            return this.view(installed.minimaxDeviceAttempt!);
          } else {
            // Invalid/malformed/native error responses do not authorize replay.
            current.minimaxDeviceAttempt = terminal(attempt, "unknown"); await this.owner.save(current);
          }
          return this.view(current.minimaxDeviceAttempt!);
        });
        return privateJson(view);
      } catch {
        operation.stop("upstream");
        // A lost commit ACK may already have installed the result. Read it;
        // never put another credential or repeat the token exchange.
        return privateJson(await this.owner.order(async () => {
          const current = await this.owner.read(), present = current?.minimaxDeviceAttempt;
          if (!current || !present || present.id !== attempt.id) conflict();
          if (active(present.phase)) { current.minimaxDeviceAttempt = terminal(present, "unknown"); await this.owner.save(current); }
          await miniMaxDeviceAdmin(request, this.env, actor);
          return this.view(current.minimaxDeviceAttempt!);
        }));
      } finally {
        operation.stop("complete");
        if (this.inFlight?.operation === operation) this.inFlight = undefined;
      }
    } catch (error) {
      return privateJson({ error: { code: error instanceof HttpError ? error.code : "minimax_device_unavailable",
        message: "MiniMax device operation unavailable" } }, error instanceof HttpError ? error.status : 503);
    }
  }

  private start(request: Request, record: CredentialRecord, descriptor: { url: string; init: RequestInit; timeoutMs: number }) {
    request.signal.throwIfAborted();
    if (Date.now() >= record.minimaxDeviceAttempt!.expiresAt) conflict();
    const operation = new HttpOperation(request.signal, Math.min(30_000, record.minimaxDeviceAttempt!.expiresAt - Date.now()));
    this.inFlight = { id: record.minimaxDeviceAttempt!.id, operation };
    operation.signal.throwIfAborted();
    // The owner tail still holds after final current-admin verification.
    // Returning a promise inside an object releases it before remote I/O.
    return { record, operation, response: fetch(descriptor.url, { ...descriptor.init, signal: operation.signal, redirect: "manual" }) };
  }

  private assertOwner(record: CredentialRecord, attempt: MiniMaxDeviceAttempt): void {
    if (record.generation !== attempt.generation || record.lineage !== attempt.lineage || record.grantKey !== attempt.key
      || record.providerId !== "minimax" || record.enabled !== true || record.revokedAt) conflict();
  }

  private async recover(record: CredentialRecord, attempt: MiniMaxDeviceAttempt) {
    this.assertOwner(record, attempt);
    if (active(attempt.phase) && (this.inFlight?.id !== attempt.id || this.inFlight.operation.signal.aborted)) {
      record.minimaxDeviceAttempt = terminal(attempt, "unknown"); await this.owner.save(record);
    } else if (attempt.phase === "pending" && Date.now() >= attempt.expiresAt) {
      record.minimaxDeviceAttempt = terminal(attempt, "expired"); await this.owner.save(record);
    }
    if (record.minimaxDeviceAttempt?.phase === "committed") await this.owner.publish(record);
    return this.view(record.minimaxDeviceAttempt!);
  }

  private view(attempt: MiniMaxDeviceAttempt) {
    return { attemptId: attempt.id, status: attempt.phase === "begin_unknown" ? "starting" : attempt.phase === "poll_unknown" ? "polling" : attempt.phase,
      expiresAt: attempt.expiresAt, nextPollAt: attempt.phase === "pending" ? attempt.nextPollAt : null,
      ...(attempt.phase === "pending" && attempt.authorization ? { userCode: attempt.authorization.userCode, verificationUri: attempt.authorization.verificationUrl } : {}) };
  }
}
