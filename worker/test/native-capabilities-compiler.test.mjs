import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const openai = parse(readFileSync("providers/openai.provider.yaml", "utf8"));
const sol = "openai/gpt-6.1-sol";
function compiler(paths) {
  return spawnSync(process.execPath, ["scripts/compile-providers.mjs", ...paths], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}
function compile(manifest) {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-native-capabilities-"));
  try {
    const path = join(directory, "provider.yaml");
    writeFileSync(path, JSON.stringify(manifest));
    return compiler([path]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function model(manifest) { return manifest.models.entries.find(model => model.id === sol); }
function facts(manifest) { return model(manifest).nativeCapabilities.endpoints.responses; }

test("all provider sources validate and generate the shipped snapshot with optional native facts intact", () => {
  const paths = readdirSync("providers").filter(path => path.endsWith(".provider.yaml")).sort().map(path => "providers/" + path);
  const result = compiler(paths);
  assert.equal(result.status, 0, result.stderr);
  const compiled = JSON.parse(result.stdout), shipped = JSON.parse(readFileSync("worker/generated/provider-snapshot.json", "utf8"));
  assert.deepEqual(compiled, shipped, "source manifests and runtime must agree");
  const provider = compiled.providers.find(provider => provider.id === "openai");
  for (const id of [sol, "openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna"]) {
    const entry = provider.models.find(model => model.id === id);
    assert.deepEqual(entry.nativeCapabilities, compiled.model_index[id].nativeCapabilities);
    assert.deepEqual(entry.nativeCapabilities.endpoints.responses.input, ["text", "image"]);
    assert.equal(entry.nativeCapabilities.endpoints.responses.contextWindow, 1050000);
    assert.equal(entry.nativeCapabilities.endpoints.responses.maxOutputTokens, 128000);
    assert.ok(!entry.capabilities.includes("llm.decisions"));
    assert.equal(entry.nativeCapabilities.endpoints.decisions, undefined, "a pending Decisions route is not advertised");
  }
  assert.equal(compiled.model_index["openai/gpt-4.1-mini"].nativeCapabilities, undefined);
  assert.deepEqual(compiled.model_index["openai/tts-1"].nativeCapabilities.endpoints.speech.input, ["text"]);
});

test("old manifests remain valid and unknown model names do not acquire native capabilities", () => {
  const manifest = structuredClone(openai);
  for (const entry of manifest.models.entries) delete entry.nativeCapabilities;
  manifest.models.entries.push({ id: "openai/gpt-999-vision", upstream: "gpt-999-vision", capabilities: ["llm.responses"] });
  const result = compile(manifest);
  assert.equal(result.status, 0, result.stderr);
  const compiled = JSON.parse(result.stdout);
  assert.ok(compiled.providers[0].models.every(model => model.nativeCapabilities === undefined));
  assert.equal(compiled.model_index["openai/gpt-999-vision"].nativeCapabilities, undefined);
});

test("compiler rejects malformed or cross-endpoint capability metadata instead of granting it", () => {
  const cases = [
    ["unknown version", m => { model(m).nativeCapabilities.version = "clawrouter.native-capabilities.v2"; }, /invalid manifest/],
    ["unknown modality", m => { facts(m).input = ["hologram"]; }, /invalid manifest/],
    ["duplicate modality", m => { facts(m).input = ["text", "text"]; }, /invalid manifest/],
    ["empty modality", m => { facts(m).input = []; }, /invalid manifest/],
    ["null facts", m => { model(m).nativeCapabilities = null; }, /invalid manifest/],
    ["missing provenance", m => { delete facts(m).sources; }, /invalid manifest/],
    ["invalid provenance", m => { facts(m).sources = ["file:///private/fixture"]; }, /invalid manifest/],
    ["invalid date", m => { facts(m).checkedAt = "yesterday"; }, /invalid manifest/],
    ["unknown grant field", m => { facts(m).allowed = true; }, /invalid manifest/],
    ["negative context", m => { facts(m).contextWindow = -1; }, /invalid manifest/],
    ["unsafe context", m => { facts(m).contextWindow = 9007199254740992; }, /invalid manifest/],
    ["context threshold", m => { facts(m).contextTokens = 1050001; }, /contextTokens/],
    ["threshold without window", m => { delete facts(m).contextWindow; }, /contextTokens/],
    ["output exceeds window", m => { facts(m).maxOutputTokens = 1050001; }, /maxOutputTokens/],
    ["zero chat output", m => { facts(m).maxOutputTokens = 0; }, /zero output/],
    ["absent endpoint", m => { model(m).nativeCapabilities.endpoints.missing = facts(m); }, /supported endpoint/],
    ["unsupported model endpoint", m => { model(m).nativeCapabilities.endpoints.embeddings = facts(m); }, /supported endpoint/],
    ["alias is not tier support", m => { facts(m).supportedServiceTiers = ["fast"]; }, /canonical priced tier/],
    ["unpriced tier", m => { facts(m).supportedServiceTiers = ["hyperspeed"]; }, /canonical priced tier/],
    ["tier on speech", m => { m.models.entries.find(e => e.id === "openai/tts-1").nativeCapabilities.endpoints.speech.supportedServiceTiers = ["default"]; }, /tier wire format/],
    ["decision on chat", m => { facts(m).inference.decision = { protocol: "openai-decisions", questions: { boolean: { probabilities: "boolean", abstention: false } }, limits: { maxQuestions: 200 } }; }, /declared Decisions endpoint/],
  ];
  for (const [name, mutate, error] of cases) {
    const manifest = structuredClone(openai); mutate(manifest);
    const result = compile(manifest);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, error, name);
    assert.equal(result.stdout, "", name + ": no partial snapshot");
  }
});

test("typed decision schema is endpoint-specific and cannot replace a conversational context or pricing budget", () => {
  const manifest = structuredClone(openai), entry = model(manifest);
  manifest.capabilities.push({ id: "llm.decisions", endpoint: "decisions", methods: ["POST"] });
  manifest.endpoints.decisions = { path: "/v1/decisions", requestFormat: "openai.decisions", responseFormat: "openai.decisions" };
  entry.capabilities.push("llm.decisions");
  entry.nativeCapabilities.endpoints.decisions = { sources: ["https://example.com/synthetic-contract"], checkedAt: "2026-10-20", input: ["text", "image", "json"], maxOutputTokens: 0,
    inference: { chat: false, decision: { protocol: "openai-decisions", reasoning: { modes: ["auto"] }, questions: { boolean: { probabilities: "boolean", abstention: false }, choice: { probabilities: "categorical", abstention: false, minOptions: 2, maxOptions: 255 }, score: { probabilities: "categorical", abstention: false } }, confidence: "provider-specific", limits: { maxQuestions: 200, image: { maxBytes: 4194304, mimeTypes: ["image/png", "image/jpeg", "image/webp"], remoteUrls: false } } } } };
  const result = compile(manifest);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).model_index[sol];
  assert.equal(output.nativeCapabilities.endpoints.decisions.maxOutputTokens, 0);
  assert.equal(output.nativeCapabilities.endpoints.responses.maxOutputTokens, 128000);
  assert.equal(output.nativeCapabilities.endpoints.responses.contextWindow, 1050000);
  assert.equal(output.pricing.defaultMaxOutputTokens, 128000);
  assert.equal(output.pricing.maxInputTokens, 922000);
  assert.equal(output.nativeCapabilities.endpoints.responses.inference.decision, undefined);
  for (const [field, value] of [["protocol", "unknown-protocol"], ["limits", { maxQuestions: 201 }], ["questions", { arbitrary: {} }]]) {
    const bad = structuredClone(manifest);
    model(bad).nativeCapabilities.endpoints.decisions.inference.decision[field] = value;
    assert.match(compile(bad).stderr, /invalid manifest/);
  }
  entry.nativeCapabilities.endpoints.decisions.inference.decision.questions.choice.minOptions = 255;
  entry.nativeCapabilities.endpoints.decisions.inference.decision.questions.choice.maxOptions = 2;
  assert.match(compile(manifest).stderr, /minOptions exceeds maxOptions/);
});
