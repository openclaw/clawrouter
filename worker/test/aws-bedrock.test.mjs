import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

import {
  copyRequestHeaders,
  providerById,
  providerReadinessFromState,
  signSigV4,
  upstreamPath,
} from "../providers.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      context.parentURL &&
      !extname(new URL(specifier, context.parentURL).pathname)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { drainResponseBody, prepareManifestRequest } = await import("../proxy.ts");

const provider = providerById("aws-bedrock");
assert.ok(provider);
const invokeModel = provider.endpoints.find((endpoint) => endpoint.id === "invoke_model");
assert.ok(invokeModel);

test("AWS Bedrock forwards allowlisted headers and enforces JSON content", () => {
  const target = new Headers();
  copyRequestHeaders(
    new Headers({
      "content-type": "text/plain",
      "x-amzn-bedrock-trace": "ENABLED",
      "x-amzn-bedrock-unknown": "must-not-pass",
    }),
    provider,
    invokeModel,
    target,
    {},
  );

  assert.equal(target.get("content-type"), "application/json");
  assert.equal(target.get("x-amzn-bedrock-trace"), "ENABLED");
  assert.equal(target.get("x-amzn-bedrock-unknown"), null);
});

test("AWS Bedrock is ready with long-lived credentials and no session token", () => {
  const readiness = providerReadinessFromState(
    {
      AWS_ACCESS_KEY_ID: "access-key",
      AWS_SECRET_ACCESS_KEY: "secret-key",
      AWS_REGION: "us-east-1",
    },
    [],
    [],
    new Map(),
  ).find((entry) => entry.id === "aws-bedrock");

  assert.ok(readiness);
  assert.deepEqual(readiness.requiredConfig, [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
  ]);
  assert.deepEqual(readiness.optionalConfig, ["AWS_SESSION_TOKEN"]);
  assert.deepEqual(readiness.missingConfig, []);
  assert.equal(readiness.configPresent, true);
  assert.deepEqual(readiness.executableEndpoints, ["invoke_model", "invoke_model_stream"]);
});

test("AWS Bedrock manifest requests accept raw path models and remove routed body models", () => {
  const pathOnly = prepareManifestRequest(
    provider,
    invokeModel,
    { inferenceConfig: { maxTokens: 16 } },
    { model: "amazon.nova-lite-v1:0" },
    {},
  );
  assert.deepEqual(pathOnly.pathParams, { model: "amazon.nova-lite-v1:0" });
  assert.deepEqual(pathOnly.body, { inferenceConfig: { maxTokens: 16 } });

  const bodyRouted = prepareManifestRequest(
    provider,
    invokeModel,
    { model: "bedrock/amazon.nova-lite-v1:0", inferenceConfig: { maxTokens: 16 } },
    {},
    {},
  );
  assert.equal(bodyRouted.model?.id, "bedrock/amazon.nova-lite-v1:0");
  assert.deepEqual(bodyRouted.pathParams, { model: "amazon.nova-lite-v1:0" });
  assert.deepEqual(bodyRouted.body, { inferenceConfig: { maxTokens: 16 } });
});

test("AWS Bedrock manifest requests reject conflicting body and path models", () => {
  assert.throws(
    () =>
      prepareManifestRequest(
        provider,
        invokeModel,
        { model: "bedrock/amazon.nova-lite-v1:0" },
        { model: "amazon.titan-text-lite-v1" },
        {},
      ),
    (error) => error?.code === "model_path_mismatch",
  );
});

test("manifest requests preserve explicit models missing from the bundled catalog", () => {
  const cohere = providerById("cohere");
  assert.ok(cohere);
  const chat = cohere.endpoints.find((endpoint) => endpoint.id === "chat");
  assert.ok(chat);

  const prepared = prepareManifestRequest(
    cohere,
    chat,
    { model: "future-model", messages: [{ role: "user", content: "hello" }] },
    {},
    {},
  );

  assert.equal(prepared.model?.id, "future-model");
  assert.equal(prepared.model?.upstream, "future-model");
  assert.equal(prepared.model?.pricing, null);
  assert.equal(prepared.body.model, "future-model");
});

test("AWS Bedrock inference-profile ARNs remain one encoded path segment", () => {
  const model =
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-lite-v1:0";
  const prepared = prepareManifestRequest(provider, invokeModel, {}, { model }, {});
  assert.equal(prepared.model?.id, model);
  assert.equal(prepared.model?.pricing, null);
  const path = upstreamPath(provider, invokeModel, prepared.pathParams, {}, {
    grant: null,
    grantKey: null,
    grantRevision: null,
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    headers: new Headers(),
    query: new URLSearchParams(),
    transportPaths: {},
  });

  assert.equal(
    path,
    "/model/arn%3Aaws%3Abedrock%3Aus-east-1%3A123456789012%3Ainference-profile%2Fus.amazon.nova-lite-v1%3A0/invoke",
  );
});

test("AWS Bedrock SigV4 signs deterministic payload and Bedrock headers", async () => {
  const body = JSON.stringify({
    schemaVersion: "messages-v1",
    messages: [{ role: "user", content: [{ text: "reply with ok" }] }],
    inferenceConfig: { maxTokens: 16 },
  });
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "x-amzn-bedrock-request-metadata": "purpose=smoke",
    "x-amzn-bedrock-trace": "ENABLED",
  });

  await signSigV4(
    provider,
    new URL(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-lite-v1%3A0/invoke",
    ),
    "POST",
    body,
    headers,
    {
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      AWS_SESSION_TOKEN: "session-token",
      AWS_REGION: "us-east-1",
    },
    null,
    new Date("2015-08-30T12:36:00.000Z"),
  );

  assert.equal(headers.get("host"), null);
  assert.equal(headers.get("x-amz-date"), "20150830T123600Z");
  assert.equal(
    headers.get("x-amz-content-sha256"),
    "ac79faa45854de501329af7cb63cf54f725694f88954805bad6a6525c57e4675",
  );
  assert.equal(headers.get("x-amz-security-token"), "session-token");
  assert.equal(
    headers.get("authorization"),
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-amzn-bedrock-request-metadata;x-amzn-bedrock-trace, Signature=d0f68b658497c226d62e9ac12d767d783bb4d74929790bb87a30a7179cd00af6",
  );
});

test("AWS Bedrock SigV4 does not fill an incomplete selected grant from global secrets", async () => {
  await assert.rejects(
    () =>
      signSigV4(
        provider,
        new URL("https://bedrock-runtime.us-east-1.amazonaws.com/model/model/invoke"),
        "POST",
        "{}",
        new Headers({ "content-type": "application/json" }),
        {
          AWS_ACCESS_KEY_ID: "global-access-key",
          AWS_SECRET_ACCESS_KEY: "global-secret-key",
          AWS_REGION: "us-east-1",
        },
        {
          provider: "aws-bedrock",
          credentials: { accessKeyId: "grant-access-key" },
        },
        new Date("2015-08-30T12:36:00.000Z"),
      ),
    (error) =>
      error?.code === "provider_not_configured" &&
      /selected AWS grant must contain accessKeyId and secretAccessKey/.test(error.message),
  );
});

test("binary Bedrock response clones are drained without buffering", async () => {
  let pulls = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        pulls += 1;
        if (pulls <= 2) controller.enqueue(Uint8Array.of(pulls));
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );

  await drainResponseBody(body);
  assert.equal(pulls, 3);
  await drainResponseBody(null);
});
