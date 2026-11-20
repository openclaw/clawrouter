import assert from "node:assert/strict";
import test from "node:test";
import { bindingCompatibilityIssue, productBindingCompatibilityIssue, bindingSupportsOperation, productSupportsBinding } from "../shared/provider-bindings.ts";
import * as portable from "../packages/provider-plugin-contract/src/bindings.ts";

const controls = ["retrieve", "cancel", "result", "metadata", "download"];
const api = { kind: "api_key" }, subscription = { kind: "subscription" };

function fixture() {
  const endpoint = { id: "invoke", websocket: "openai.responses",
    responsesLifecycle: { retrieve: "retrieve", cancel: "cancel" },
    lifecycle: { protocol: "replicate.predictions", retrieve: "retrieve", cancel: "cancel", result: "result",
      files: { metadata: "metadata", download: "download" } } };
  const transport = { allowedEndpoints: [endpoint.id, ...controls] };
  const provider = { auth: { grantTransports: { subscription: transport } },
    endpoints: [endpoint, ...controls.map(id => ({ id }))] };
  const product = { binding: { type: "provider-default" }, endpoints: [endpoint.id, ...controls] };
  const memberProduct = { ...product, binding: { type: "grant-transport", grantKind: "subscription" } };
  return { requirement: { provider, endpoint, mode: "http" }, product, memberProduct, transport };
}

function check(requirement, grant, expected, product, productExpected = expected) {
  assert.equal(bindingCompatibilityIssue(requirement, grant), expected);
  assert.equal(bindingSupportsOperation(requirement, grant), expected === null);
  if (product) {
    assert.equal(productBindingCompatibilityIssue(requirement, product, grant), productExpected);
    assert.equal(productSupportsBinding(requirement, product, grant), productExpected === null);
  }
}

test("shared diagnostics use the portable implementation", () => {
  assert.equal(bindingCompatibilityIssue, portable.bindingCompatibilityIssue);
  assert.equal(productBindingCompatibilityIssue, portable.productBindingCompatibilityIssue);
});

test("product transport diagnostics do not infer authentication or subscription entitlement", () => {
  const { requirement, product, memberProduct } = fixture();
  for (const grant of [null, {}, api, { kind: "oauth" }]) {
    check(requirement, grant, null, product);
    check(requirement, grant, null, memberProduct, "product_transport_mismatch");
  }
  check(requirement, subscription, null, product, "product_transport_mismatch");
  check(requirement, subscription, null, memberProduct);
  delete requirement.provider.auth.grantTransports.subscription;
  check(requirement, subscription, null, memberProduct, "product_transport_mismatch");
});

test("operation and product endpoint allowlists report their distinct owner", () => {
  const { requirement, product, memberProduct, transport } = fixture();
  transport.allowedEndpoints = controls;
  check(requirement, subscription, "transport_endpoint_unsupported", memberProduct);
  product.endpoints = controls;
  check(requirement, api, null, product, "product_endpoint_unsupported");
  memberProduct.endpoints = controls;
  check(requirement, subscription, "transport_endpoint_unsupported", memberProduct, "product_endpoint_unsupported");
});

test("requested lifecycle absence is distinct from missing lifecycle endpoints", () => {
  const { requirement, product } = fixture();
  delete requirement.endpoint.responsesLifecycle;
  check({ ...requirement, responsesLifecycle: true }, api, "lifecycle_unavailable", product);
  check({ ...requirement, managedLifecycle: true, mode: "websocket" }, api, "lifecycle_unavailable", product);
});

for (const [flag, dependencies] of [["responsesLifecycle", ["retrieve", "cancel"]], ["managedLifecycle", controls]]) {
  for (const id of dependencies) test(`${flag} reports missing ${id} at each declaration boundary`, () => {
    const { requirement, product, memberProduct, transport } = fixture();
    requirement[flag] = true;
    check(requirement, api, null, product);
    check(requirement, subscription, null, memberProduct);
    requirement.provider.endpoints = requirement.provider.endpoints.filter(endpoint => endpoint.id !== id);
    check(requirement, api, "lifecycle_endpoint_unsupported", product);
    requirement.provider.endpoints.push({ id });
    transport.allowedEndpoints = transport.allowedEndpoints.filter(endpoint => endpoint !== id);
    check(requirement, subscription, "lifecycle_endpoint_unsupported", memberProduct);
    product.endpoints = product.endpoints.filter(endpoint => endpoint !== id);
    check(requirement, api, null, product, "product_endpoint_unsupported");
  });
}

test("WebSocket diagnostics retain realtime credential and default-transport restrictions", () => {
  const { requirement, product, memberProduct } = fixture();
  requirement.mode = "websocket";
  check(requirement, api, null, product);
  check(requirement, subscription, "websocket_unsupported", memberProduct);
  requirement.endpoint.websocket = "openai.realtime";
  check({ ...requirement, mode: "http" }, api, "operation_requires_websocket", product);
  check(requirement, api, null, product);
  check(requirement, { kind: "oauth" }, "websocket_unsupported", product);
  delete requirement.endpoint.websocket;
  check(requirement, api, "websocket_unsupported", product);
});

test("diagnostics preserve first-failure order and never fetch or mutate input", t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected fetch"); });
  const { requirement, product, transport } = fixture();
  transport.allowedEndpoints = [];
  requirement.responsesLifecycle = true;
  delete requirement.endpoint.responsesLifecycle;
  const before = structuredClone({ requirement, product });
  check(requirement, subscription, "transport_endpoint_unsupported", product, "product_transport_mismatch");
  check(requirement, api, "lifecycle_unavailable", product);
  assert.deepEqual({ requirement, product }, before);
  assert.equal(fetch.mock.callCount(), 0);
});
