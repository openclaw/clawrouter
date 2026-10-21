import { authorityCall } from "./authority.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { compactionWitnessBatchLimit, type CompactionWitness, type WitnessBinding } from "./compaction-witness-store.ts";
import { createResponsesToolEvidence, retainedToolBase, type ToolKnowledge } from "./responses-tool-evidence.ts";
import type { AuthorizedIdentity, Env } from "./types.ts";
import { sha256Hex } from "./utils.ts";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= 256;

// A bounded projection of the existing parser, not a second body reader/parser.
// Ciphertext is held only transiently for hashing; it never enters a durable
// request, usage event, log, error, or rewritten upstream/downstream window.
export class CompactionWitnessProducer {
  private readonly createdAtMs = Date.now();
  private readonly producerId = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  private readonly evidence: ReturnType<typeof createResponsesToolEvidence>;
  private checkpoints: Array<{ id: string; encrypted: string }> = [];
  private owner?: ContinuationOwner;
  private invalid = false;
  private finished = false;
  private terminal = false;
  private knowledge: ToolKnowledge = "unknown";
  private readonly env: Env;
  private readonly scope: string;
  private readonly auth: AuthorizedIdentity;
  private readonly model: string;
  constructor(env: Env, scope: string, auth: AuthorizedIdentity, model: string, body: Record<string, unknown>, inherited: ToolKnowledge) {
    this.env = env; this.scope = scope; this.auth = auth; this.model = model;
    // Root tools do not become ordinary previous_response_id inventories, but
    // compaction hides this generation too. Preserve their possible charges.
    // Encrypted reasoning is not an attested compaction item. Do not let an
    // ordinary Responses round trip launder unknown opaque ancestry into a
    // token-only checkpoint; existing endpoint admission/delivery is unchanged.
    const opaqueReasoning = Array.isArray(body.input) && body.input.some(item => object(item) && item.type === "reasoning" && item.encrypted_content != null);
    const base = opaqueReasoning ? "unknown" : inherited;
    this.evidence = createResponsesToolEvidence(body.tools === undefined ? base : retainedToolBase({ input: [{ type: "additional_tools", tools: body.tools }] }, base));
  }
  bind(owner: ContinuationOwner): void { this.owner = owner; }
  observe(value: unknown, sse: boolean): void {
    if (this.invalid) return;
    // Tool evidence stops at its first terminal. Reject every later event and
    // unsuccessful terminal here, rather than certifying a different snapshot
    // with the earlier terminal's tool knowledge. [DONE] is not an observation.
    if (!object(value) || this.terminal || sse && ["response.incomplete", "response.failed", "error"].includes(value.type as string)) { this.invalidate(); return; }
    const response = sse ? value.response : value;
    const completed = sse ? value.type === "response.completed" : value.object === "response.compaction" || value.object === "response" && value.status === "completed";
    if (completed && object(response)) {
      this.terminal = true;
      if (!Array.isArray(response.output)) { this.invalid = true; return; }
      for (const item of response.output) if (object(item) && item.type === "compaction") {
        if (!text(item.id) || typeof item.encrypted_content !== "string" || !item.encrypted_content.length || item.encrypted_content.length > 131_072 || this.checkpoints.length >= compactionWitnessBatchLimit) { this.invalid = true; return; }
        this.checkpoints.push({ id: item.id, encrypted: item.encrypted_content });
      }
    }
    // The validator still checks every event/inventory/association. Only the
    // checkpoint itself is opaque token state, not a new tool declaration.
    const sanitize = (item: unknown) => object(item) && item.type === "compaction" ? { ...item, type: "message", encrypted_content: undefined } : item;
    const snapshot = (item: Record<string, unknown>) => ({ ...item, ...(Array.isArray(item.output) ? { output: item.output.map(sanitize) } : {}) });
    const projected = sse ? { ...value, ...(object(value.item) ? { item: sanitize(value.item) } : {}), ...(object(value.response) ? { response: snapshot(value.response) } : {}) } : snapshot(value);
    if (!sse && value.object === "response.compaction") Object.assign(projected, { object: "response", status: "completed" });
    this.evidence.accept(projected, sse);
    this.knowledge = this.evidence.result()?.knowledge ?? "unknown";
  }
  invalidate(): void { this.invalid = true; this.checkpoints.length = 0; }
  async finish(signal: AbortSignal): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const checkpoints = this.checkpoints; this.checkpoints = [];
    if (this.invalid || !this.terminal || !this.owner || !checkpoints.length || signal.aborted) return;
    const binding: WitnessBinding = { authType: this.auth.authType, tenantId: this.auth.policy.tenantId ?? "default", policyId: this.auth.policyId, credentialId: this.auth.credentialId, principalId: this.auth.principalId, model: this.model, owner: this.owner };
    const witnesses: CompactionWitness[] = await Promise.all(checkpoints.map(async item => ({ version: 1, itemId: item.id, ciphertextSha256: await sha256Hex(item.encrypted), binding, knowledge: this.knowledge, producerId: this.producerId, createdAtMs: this.createdAtMs })));
    if (signal.aborted) return;
    // Producer-before-consumer rollout: missing/failed/conflicting writes are
    // never positive evidence. Do not change existing delivery or accounting.
    try { await authorityCall(this.env, "/http-continuations", { action: "witness_register", keys: [], witnesses }, this.scope, AbortSignal.any([signal, AbortSignal.timeout(5000)])); } catch { /* unknown witness; no plaintext diagnostics */ }
  }
}
