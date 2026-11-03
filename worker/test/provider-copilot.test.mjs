import assert from "node:assert/strict";
import test from "node:test";
import { copilotAccountRequest, copilotGithubDomain, copilotModelFormats, filterCopilotModels, prepareCopilotRequest, qualifyCopilotIdentity } from "../provider-copilot.ts";

const secret = "synthetic-github-token", owner = "fixture-grant:version-2";
const model = { id: "fixture-model", vendor: "fixture", policy: { state: "enabled" }, supported_endpoints: ["/v1/chat/completions", "/responses", "/messages"] };

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
