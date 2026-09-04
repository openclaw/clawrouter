import { record, type PrivateUpstream } from "./private-codex-config";
import { privateResponseHeaders } from "./private-codex-protocol";
import type { PrivateContinuationProjection } from "./private-codex-continuation";

// Inspect data without assigning protocol meaning to its keys or rewriting ciphertext/tool JSON.
export function inspectPrivateContent(value: unknown, sensitive: readonly string[], depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 50_000 || depth > 48) throw new Error("private structure limit");
  if (typeof value === "string") {
    if (sensitive.some((secret) => value.includes(secret))) throw new Error("private content rejected");
    if (/^\s*[\[{]/.test(value)) {
      let nested: unknown;
      try { nested = JSON.parse(value); } catch { return; }
      inspectPrivateContent(nested, sensitive, depth + 1, budget);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) inspectPrivateContent(item, sensitive, depth + 1, budget);
  } else if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      inspectPrivateContent(key, sensitive, depth + 1, budget);
      inspectPrivateContent(item, sensitive, depth + 1, budget);
    }
  }
}

// Owns the Responses envelopes, not arbitrary recursively nested model/error/header keys.
// Reporting identity is sensitive data; it NEVER becomes an authorized routing identity.
export class PrivateResponseProjection {
  readonly alias: string;
  private readonly target: string;
  private readonly sensitive: string[];
  private reported: string | undefined;
  private sealed = false;
  private rejected = false;
  private readonly continuation: PrivateContinuationProjection | undefined;

  constructor(alias: string, upstream: PrivateUpstream, continuation?: PrivateContinuationProjection) {
    this.alias = alias;
    this.continuation = continuation;
    this.target = upstream.target;
    this.sensitive = [upstream.target, upstream.accessToken, upstream.accountId, ...(upstream.fallbackTarget ? [upstream.fallbackTarget] : [])];
  }

  get sensitiveValues(): readonly string[] { return this.sensitive; }

  // A new matcher cannot safely be introduced after output or logical-delta history.
  seal(): void { this.sealed = true; }

  inspect(value: unknown): void { inspectPrivateContent(value, this.sensitive); }

  async headers(entries: Iterable<[string, unknown]>): Promise<Record<string, unknown>> {
    const projected = privateResponseHeaders(entries, this.alias, this.target, this.sensitive);
    this.inspect(projected);
    if (this.continuation && projected["x-codex-turn-state"] !== undefined) projected["x-codex-turn-state"] = await this.continuation.wrap(projected["x-codex-turn-state"]);
    return projected;
  }

  async response(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.rejected) throw new Error("private reporting identity rejected");
    const projected = await this.responseEnvelope(value);
    this.inspect(projected);
    return projected;
  }

  async event(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.rejected) throw new Error("private reporting identity rejected");
    const projected = { ...value };
    // Register before inspecting any sibling, irrespective of JSON property order.
    if (value.response != null) {
      if (!record(value.response)) throw new Error("private response envelope invalid");
      projected.response = await this.responseEnvelope(value.response);
    }
    if (value.headers !== undefined) projected.headers = await this.headerEnvelope(value.headers);
    if (value.safety_buffering !== undefined) projected.safety_buffering = this.safety(value.safety_buffering);
    if (value.type === "response.metadata" && record(value.metadata) && value.metadata.type === "safety_buffering") {
      projected.metadata = this.safety(value.metadata);
    }
    this.inspect(projected);
    if (this.continuation && value.response_id !== undefined) projected.response_id = await this.continuation.wrap(value.response_id);
    return projected;
  }

  private async responseEnvelope(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const projected = { ...value };
    if (value.model !== undefined) {
      this.learn(value.model);
      projected.model = this.alias;
    }
    if (value.error != null) throw new Error("private upstream error");
    if (value.headers !== undefined) projected.headers = await this.headerEnvelope(value.headers);
    if (this.continuation) {
      for (const key of ["id", "previous_response_id"]) {
        if (value[key] == null) continue;
        this.inspect(value[key]);
        projected[key] = await this.continuation.wrap(value[key]);
      }
    }
    return projected;
  }

  private learn(value: unknown): void {
    if (typeof value !== "string" || !/^[\x20-\x7e]{1,128}$/.test(value) || !value.trim()) throw new Error("private reporting identity invalid");
    if (value === this.alias || value === this.target || value === this.reported) return;
    // Also contain the first rejected candidate in the terminal failure; parsing stops on throw.
    if (!this.sensitive.includes(value)) this.sensitive.push(value);
    // One additional identity per response, declared before any body release/history.
    if (this.sealed || this.reported !== undefined) {
      this.rejected = true;
      throw new Error("private reporting identity changed");
    }
    this.reported = value;
  }

  private async headerEnvelope(value: unknown): Promise<Record<string, unknown>> {
    if (!record(value)) throw new Error("private protocol headers invalid");
    return this.headers(Object.entries(value));
  }

  private safety(value: unknown): Record<string, unknown> {
    if (!record(value)) throw new Error("private safety envelope invalid");
    const projected = { ...value };
    // retry_model is the current wire field. Other selector spellings cannot bypass it.
    for (const key of ["model", "retry_model", "faster_model", "auto_review_model_override"]) {
      if (value[key] == null) continue;
      if (value[key] !== this.target && value[key] !== this.alias) throw new Error("private safety model mismatch");
      projected[key] = this.alias;
    }
    return projected;
  }
}
