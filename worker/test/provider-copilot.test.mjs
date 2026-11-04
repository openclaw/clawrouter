import assert from "node:assert/strict";
import test from "node:test";
import { copilotAccountRequest, copilotGithubDomain, copilotModelFormats, filterCopilotModels, isCopilotCatalogModelVisible, prepareCopilotRequest, qualifyCopilotIdentity } from "../provider-copilot.ts";

const secret = "synthetic-github-token", owner = "fixture-grant:version-2";
const model = { id: "fixture-model", vendor: "fixture", model_picker_enabled: true, policy: { state: "enabled" }, supported_endpoints: ["/v1/chat/completions", "/responses", "/messages"] };

test("account discovery keeps public and enterprise identities on their selected domains", () => {
  for (const domain of ["github.com", "fixture.ghe.com"]) {
    const request = copilotAccountRequest(domain, secret);
    assert.equal(request.url, `https://api.${domain}/copilot_internal/user`);
    assert.equal(request.headers.get("authorization"), `Bearer ${secret}`);
    assert.equal(request.redirect, "manual");
  }
  for (const value of ["", "https://github.com", "other.example.com", "tenant.ghe.com.evil.example", "-tenant.ghe.com", "github.com/path"]) assert.throws(() => copilotGithubDomain(value), /invalid_copilot_github_domain/);
});

test("account endpoint selection allows product hosts and the selected enterprise only", () => {
  assert.equal(qualifyCopilotIdentity({}, "github.com", owner).apiBaseUrl, "https://api.individual.githubcopilot.com");
  assert.equal(qualifyCopilotIdentity({}, "fixture.ghe.com", owner).apiBaseUrl, "https://copilot-api.fixture.ghe.com");
  for (const api of ["https://api.business.githubcopilot.com", "https://copilot-proxy.githubusercontent.com", "https://copilot-api.fixture.ghe.com"]) assert.equal(qualifyCopilotIdentity({ endpoints: { api } }, "fixture.ghe.com", owner).apiBaseUrl, api);
  for (const api of ["https://copilot-api.other.ghe.com", "https://githubcopilot.com.evil.example", "http://api.individual.githubcopilot.com", "https://api.individual.githubcopilot.com:8443", "https://user:secret@api.individual.githubcopilot.com", "https://api.individual.githubcopilot.com?secret=x"]) assert.throws(() => qualifyCopilotIdentity({ endpoints: { api } }, "fixture.ghe.com", owner), /invalid_copilot_api_origin/);
});

test("discovered endpoints authorize transports without guessing from model names", () => {
  assert.deepEqual(copilotModelFormats(model), ["openai.chat_completions", "openai.responses", "anthropic.messages"]);
  assert.deepEqual(copilotModelFormats({ id: "claude-looking-name" }), []);
  const response = { object: "list", data: [model, { ...model, id: "private" }, { ...model, id: "disabled", policy: { state: "disabled" } }, { id: "no-transport" }] };
  assert.deepEqual(filterCopilotModels(response, id => id !== "private"), { object: "list", data: [model] });
  assert.equal(response.data.length, 4);
});

test("native request uses the bound original credential, model and selected supported protocol", async () => {
  const identity = qualifyCopilotIdentity({}, "github.com", owner);
  const body = { model: "caller-alias", messages: [{ role: "user", content: "synthetic request" }], stream: true, tools: [{ type: "function", function: { name: "forecast" } }] };
  for (const [format, path] of [["openai.chat_completions", "/chat/completions"], ["openai.responses", "/responses"], ["anthropic.messages", "/messages"]]) {
    const request = prepareCopilotRequest(body, identity, owner, secret, model, format);
    assert.equal(request.url, identity.apiBaseUrl + path);
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), `Bearer ${secret}`);
    assert.equal(request.headers.get("x-api-key"), null);
    assert.deepEqual(await request.json(), { ...body, model: model.id });
  }
  assert.throws(() => prepareCopilotRequest(body, identity, "other-grant", secret, model, "openai.responses"), /invalid_copilot_owner_binding/);
  assert.throws(() => prepareCopilotRequest(body, identity, owner, secret, { ...model, supported_endpoints: ["/messages"] }, "openai.responses"), /invalid_copilot_model_transport/);
  assert.throws(() => prepareCopilotRequest(body, identity, owner, "synthetic\r\ninjected", model, "openai.responses"), error => error.message === "invalid_copilot_credential");
});

// OpenClaw 31ad71a8addc1d42fbc5478f7e114860f5cbf6c7 models.ts:114–120.
// These facts govern the picker, not consent, pricing or inference authority.
for (const [name, policy, picker, visible] of [
  ["enabled", { state: "enabled" }, true, true],
  ["disabled", { state: "disabled" }, true, false],
  ["unconfigured consent", { state: "unconfigured" }, true, false],
  ["normalized disabled", { state: " DISABLED " }, true, false],
  ["normalized unconfigured", { state: " Unconfigured " }, true, false],
  ["missing policy", undefined, true, true],
  ["unknown policy", { state: "future-policy" }, true, true],
  ["hidden picker", { state: "enabled" }, false, false],
  ["missing picker", { state: "enabled" }, undefined, false],
  ["non-boolean picker", { state: "enabled" }, "true", false],
]) {
  test(`native picker visibility: ${name}`, () => {
    const row = { ...model, policy, model_picker_enabled: picker };
    assert.equal(isCopilotCatalogModelVisible(row), visible);
    assert.deepEqual(filterCopilotModels({ data: [row] }, () => true), { data: visible ? [row] : [] });
    assert.deepEqual(filterCopilotModels({ data: [row] }, () => false), { data: [] });
    if (!visible) {
      assert.throws(() => prepareCopilotRequest({}, qualifyCopilotIdentity({}, "github.com", owner), owner, secret, row, "openai.responses"), /invalid_copilot_model_transport/);
    }
  });
}

test("empty, denied and unconfigured catalogs never resurrect static model seeds", () => {
  assert.deepEqual(filterCopilotModels({ data: [] }, () => true), { data: [] });
  assert.deepEqual(filterCopilotModels({ data: [
    { ...model, id: "disabled", policy: { state: "disabled" } },
    { ...model, id: "consent-required", policy: { state: "unconfigured" } },
    { ...model, id: "hidden", model_picker_enabled: false },
  ] }, () => true), { data: [] });
  assert.throws(() => filterCopilotModels({ data: [model, model] }, () => false), /invalid_copilot_model/);
  assert.throws(() => filterCopilotModels({ data: [null] }, () => true), /invalid_copilot_model/);
});

// Frozen native manifest IDs/API/status only; no inherited vendor prices or limits.
const frozenModels = [
  ["claude-fable-5", "anthropic.messages", null],
  ["claude-opus-5.5", "anthropic.messages", null],
  ["claude-opus-5", "anthropic.messages", null],
  ["claude-sonnet-5.5", "anthropic.messages", null],
  ["claude-sonnet-5", "anthropic.messages", null],
  ["claude-haiku-4.5", "anthropic.messages", null],
  ["claude-opus-4.8", "anthropic.messages", "deprecated"],
  ["claude-sonnet-4.6", "anthropic.messages", "deprecated"],
  ["gemini-3.6-flash", "openai.chat_completions", null],
  ["gemini-3.1-pro-preview", "openai.chat_completions", null],
  ["gemini-3.5-flash", "openai.chat_completions", "deprecated"],
  ["gemini-2.5-pro", "openai.chat_completions", "deprecated"],
  ["gpt-5.6-sol", "openai.responses", null],
  ["gpt-5.6-terra", "openai.responses", null],
  ["gpt-5.6-luna", "openai.responses", null],
  ["gpt-5.3-codex", "openai.responses", null],
  ["gpt-5.4", "openai.responses", "deprecated"],
  ["gpt-5.5", "openai.responses", "deprecated"],
  ["gpt-5.4-mini", "openai.responses", "deprecated"],
];
const nativePaths = { "anthropic.messages": "/messages", "openai.chat_completions": "/chat/completions", "openai.responses": "/responses" };
for (const [id, format, status] of frozenModels) {
  test(`frozen Copilot protocol remains explicit: ${id}`, async () => {
    const row = { id, ...(status ? { status } : {}), model_picker_enabled: true, policy: { state: "enabled" }, supported_endpoints: [nativePaths[format]] };
    assert.deepEqual(copilotModelFormats(row), [format]);
    assert.deepEqual(copilotModelFormats({ ...row, supported_endpoints: [] }), []);
    assert.deepEqual(filterCopilotModels({ data: [row] }, candidate => candidate === id), { data: [row] });
    const identity = qualifyCopilotIdentity({}, "github.com", owner);
    const request = prepareCopilotRequest({ model: "caller-alias" }, identity, owner, secret, row, format);
    assert.equal(request.url, identity.apiBaseUrl + nativePaths[format]);
    assert.deepEqual(await request.json(), { model: id });
    for (const other of Object.keys(nativePaths).filter(candidate => candidate !== format)) {
      assert.throws(() => prepareCopilotRequest({}, identity, owner, secret, row, other), /invalid_copilot_model_transport/);
    }
    assert.equal("cost" in row, false);
    assert.equal("maxTokens" in row, false);
  });
}
