import "../../test/helpers/typescript-resolver.mjs";
import { captureTimeouts } from "../../test/helpers/timeout-capture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === pathToFileURL(new URL("../discovery.ts", import.meta.url).pathname).href) {
      if (specifier === "./access") {
        return { shortCircuit: true, url: new URL("./avatar-fetch.mocks.mjs", import.meta.url).href };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { avatarResponse } = await import("../discovery.ts");

const gravatarHash = createHash("sha256").update("admin@example.com").digest("hex");
const gravatarUrl = `https://www.gravatar.com/avatar/${gravatarHash}?s=60&d=identicon&r=g`;

function avatarRequest() {
  return new Request("https://console.example/v1/session/avatar");
}

test("session avatar Gravatar fetch attaches a 30s AbortSignal", async (context) => {
  const timeouts = captureTimeouts(context);
  let avatarInit;
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), gravatarUrl);
    avatarInit = init;
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });
  });

  const response = await avatarResponse(avatarRequest(), {});
  assert.equal(response.status, 200);
  assert.ok(avatarInit?.signal instanceof AbortSignal);
  assert.equal(avatarInit.signal.aborted, false);
  assert.deepEqual(timeouts, [30_000]);
});

test("session avatar fetch aborts a hung Gravatar instead of stalling the Worker", { timeout: 2_000 }, async (context) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const timeouts = captureTimeouts(context, 40);
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), gravatarUrl);
    return nativeFetch(`http://127.0.0.1:${port}/hung`, { signal: init?.signal });
  });

  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await assert.rejects(
    avatarResponse(avatarRequest(), {}),
    (error) => error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"),
  );
  assert.deepEqual(timeouts, [30_000]);
});
