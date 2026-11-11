import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { ProxyCompletion } = await import("../proxy-completion.ts");
const { createProxyAccounting } = await import("../proxy-accounting.ts");
const { prepareContentRetention } = await import("../content-retention.ts");
const { observeUsage } = await import("../proxy-response.ts");
const { HttpOperation } = await import("../http-operation.ts");
const { correlateIngressRequest } = await import("../correlation.ts");

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
// Every started root is immediately observed. Cleanup never deduplicates reasons.
function ownership(t) {
  const releases = [], roots = [], releaseErrors = []; let hasPrimary = false, primary, released = false;
  const releaseAll = () => { if (released) return; released = true; for (const release of releases) try { release(); } catch (error) { releaseErrors.push(error); } };
  t.signal.addEventListener("abort", releaseAll, { once: true });
  const track = work => { roots.push(work.then(() => ({ failed: false }), error => ({ failed: true, error }))); return work; };
  t.after(async () => {
    releaseAll(); const failures = [...releaseErrors];
    t.signal.removeEventListener("abort", releaseAll);
    let index = 0;
    while (index < roots.length) {
      const batch = roots.slice(index); index = roots.length;
      for (const outcome of await Promise.all(batch)) if (outcome.failed) failures.push(outcome.error);
    }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "completion test roots");
  });
  return { track, release: fn => releases.push(fn), async run(fn) { try { await fn(); } catch (error) { hasPrimary = true; primary = error; throw error; } } };
}
const outcome = work => work.then(value => ({ failed: false, value }), error => ({ failed: true, error }));

test("private leaf preserves the original promise across reentrant seal and joins without a child", { timeout: 10_000 }, async t => {
  const o = ownership(t), owner = new ProxyCompletion(), held = deferred();
  let finished = false, invoked = 0;
  o.release(() => { held.resolve(); owner.seal(); }); o.track(owner.completion);
  await o.run(async () => {
    const original = owner.startPrivateLeaf(() => { invoked++; owner.seal(); return held.promise; });
    assert.equal(original, held.promise); assert.equal(invoked, 1);
    void owner.completion.then(() => { finished = true; });
    await tick(); assert.equal(finished, false);
    let forbidden = false;
    assert.throws(() => owner.startPrivateLeaf(() => { forbidden = true; return Promise.resolve(); }), /enrollment is closed/);
    assert.equal(forbidden, false);
    held.resolve({ ignored: true });
    assert.deepEqual(await owner.completion, { failed: false, unused: false });
  });
});

test("private leaves preserve synchronous and independent rejected undefined/shared origins", { timeout: 10_000 }, async t => {
  const o = ownership(t), owner = new ProxyCompletion(), shared = Error("independent private leaves");
  o.release(() => owner.seal()); o.track(owner.completion);
  for (const reason of [undefined, shared]) {
    let present = false;
    try { owner.startPrivateLeaf(() => { throw reason; }); } catch (error) { present = true; assert.equal(error, reason); }
    assert.equal(present, true);
  }
  for (const reason of [undefined, shared, shared]) {
    const original = Promise.reject(reason), observed = outcome(original);
    assert.equal(owner.startPrivateLeaf(() => original), original);
    assert.deepEqual(await o.track(observed), { failed: true, error: reason });
  }
  owner.seal();
  assert.deepEqual(await owner.completion, { failed: true, unused: false });
});

test("private leaf false needs explicit fail and unused completion stays unchanged", async () => {
  const unused = new ProxyCompletion(); unused.seal();
  assert.deepEqual(await unused.completion, { failed: false, unused: true });
  for (const failed of [false, true]) {
    const owner = new ProxyCompletion();
    await owner.startPrivateLeaf(() => Promise.resolve(false));
    if (failed) owner.fail();
    owner.seal(); assert.deepEqual(await owner.completion, { failed, unused: false });
  }
});

test("private leaf observation failure holds enrollment after work starts", async () => {
  const owner = new ProxyCompletion(), original = Promise.resolve();
  let invoked = 0, complete = false, present = false;
  Object.defineProperty(original, "then", { configurable: true, get() { throw undefined; } });
  try { owner.startPrivateLeaf(() => { invoked++; return original; }); }
  catch (error) { present = true; assert.equal(error, undefined); }
  delete original.then;
  owner.seal(); void owner.completion.then(() => { complete = true; });
  await original; await tick();
  assert.equal(present, true); assert.equal(invoked, 1); assert.equal(complete, false);
});

test("completion enrolls before invocation and preserves original promise, sync throw and undefined", { timeout: 10_000 }, async t => {
  const o = ownership(t), owner = new ProxyCompletion(), graph = { payload: [1] };
  o.release(() => owner.seal());
  o.track(owner.completion);
  const original = Promise.resolve(graph);
  assert.equal(owner.start(() => original), original);
  for (const reason of [undefined, new Error("synthetic synchronous failure")]) {
    let caught = false;
    try { owner.start(() => { throw reason; }); } catch (error) { caught = true; assert.equal(error, reason); }
    assert.equal(caught, true);
  }
  const shared = Error("same reason, distinct roots");
  for (const reason of [undefined, shared, shared]) {
    const rejected = Promise.reject(reason), work = owner.start(() => rejected);
    assert.equal(work, rejected);
    assert.deepEqual(await o.track(outcome(work)), { failed: true, error: reason });
  }
  owner.seal(); owner.seal();
  assert.deepEqual(await owner.completion, { failed: true, unused: false });
  assert.deepEqual(Object.keys(await owner.completion), ["failed", "unused"]);
  let invoked = false;
  assert.throws(() => owner.start(() => { invoked = true; return original; }), /enrollment is closed/);
  assert.equal(invoked, false);
});

for (const rejects of [false, true]) test(`sealed top waits for a live parent's late child; parent rejects=${rejects}`, { timeout: 10_000 }, async t => {
  const o = ownership(t), owner = new ProxyCompletion(), parent = deferred(), child = deferred();
  let branch, done = false, childStarted = false;
  o.release(() => { parent.resolve(); child.resolve(); owner.seal(); });
  o.track(owner.completion);
  await o.run(async () => {
    const work = owner.start(children => { branch = children; return parent.promise; });
    const observed = o.track(outcome(work));
    owner.seal(); void owner.completion.then(() => { done = true; });
    o.track(branch.start(() => { childStarted = true; return child.promise; }));
    if (rejects) parent.reject(undefined); else parent.resolve({ ignored: true });
    assert.equal((await observed).failed, rejects); await tick();
    assert.equal(childStarted, true); assert.equal(done, false);
    assert.throws(() => branch.start(() => Promise.resolve()), /enrollment is closed/);
    child.resolve();
    assert.deepEqual(await owner.completion, { failed: rejects, unused: false });
  });
});

test("synchronous undefined still joins children enrolled before the throw", { timeout: 10_000 }, async t => {
  const o = ownership(t), owner = new ProxyCompletion(), child = deferred(); let done = false;
  o.release(() => { child.resolve(); owner.seal(); }); o.track(owner.completion);
  await o.run(async () => {
    let caught = false;
    try { owner.start(parent => { parent.start(() => child.promise); throw undefined; }); }
    catch (error) { caught = true; assert.equal(error, undefined); }
    assert.equal(caught, true); owner.seal(); void owner.completion.then(() => { done = true; });
    await tick(); assert.equal(done, false); child.resolve();
    assert.deepEqual(await owner.completion, { failed: true, unused: false });
  });
});

const auth = () => ({ policyId: "fixture", credentialId: "key", principalId: "member", authType: "proxy_key",
  policy: { tenantId: "fixture", requestCostMicros: 7, retainRequestContent: true } });
const selection = () => ({ provider: { id: "fixture" }, model: null, capability: "llm.chat", method: "POST",
  endpoint: { request_format: "openai.chat_completions", response_format: "openai.chat_completions" }, body: { messages: [{ role: "user", content: "fixture" }] } });
function accounting(owner, env, track) {
  const request = new Request("https://router.example/v1/chat/completions", { headers: { "x-request-id": "fixture-completion" } });
  correlateIngressRequest(request);
  return createProxyAccounting({ completion: owner, env, context: { waitUntil: track }, request, auth: auth(), selection: selection(),
    cost: { reserveMicros: 7, basis: "policy_fixed", inputTokens: null, outputTokens: null } });
}
const reservation = { reservations: [], reservedMicros: 0 };

for (const method of ["settle", "complete", "pricingFailure", "fail"]) for (const rejects of [false, true]) {
  test(`accounting ${method} owns its actual terminal promise, sink rejects=${rejects}`, { timeout: 10_000 }, async t => {
    const o = ownership(t), owner = new ProxyCompletion(), gate = deferred(), entered = deferred();
    let calls = 0, done = false;
    const env = { USAGE_QUEUE: { async send() { calls++; entered.resolve(); await gate.promise; } },
      USAGE_LEDGER: { idFromName: x => x, get: () => ({ fetch() { return Promise.reject(undefined); } }) } };
    const a = accounting(owner, env, o.track);
    o.release(() => { gate.resolve(); a.close(); owner.seal(); });
  o.track(owner.completion);
    await o.run(async () => {
      let work;
      if (method === "settle") work = a.settle(200, "success", true, null, reservation, null);
      else if (method === "pricingFailure") work = a.pricingFailure(null, reservation, null);
      else if (method === "complete") work = a.complete(new Response(null, { status: 200 }), { delivery: "complete", tokens: null, outcome: null }, reservation, null);
      else a.fail(402, "denied");
      if (work) o.track(work);
      owner.seal(); void owner.completion.then(() => { done = true; });
      await Promise.race([entered.promise, owner.completion.then(() => { throw Error("completion before sink arrival"); })]);
      assert.equal(calls, 1); assert.equal(done, false);
      if (rejects) gate.reject(undefined); else gate.resolve();
      if (work) assert.equal(await work, !rejects);
      assert.deepEqual(await a.completion, { failed: rejects, unused: false });
      assert.equal((await owner.completion).failed, rejects);
      a.close(); a.close(); assert.equal(calls, 1, "receipt observation never replays a sink");
    });
  });
}

test("unused accounting is explicit and a fork keeps custody after the parent finishes", { timeout: 10_000 }, async t => {
  const o = ownership(t), owner = new ProxyCompletion(), hold = deferred(), entered = deferred(), events = [];
  const env = { USAGE_QUEUE: { async send(event) { events.push(event); if (events.length === 2) { entered.resolve(); await hold.promise; } } } };
  const unused = accounting(owner, env, o.track); unused.close();
  assert.deepEqual(await unused.completion, { failed: false, unused: true }); assert.equal(events.length, 0);
  const parent = accounting(owner, env, o.track), child = parent.fork();
  o.release(() => { hold.resolve(); parent.close(); child.close(); owner.seal(); });
  o.track(owner.completion);
  await o.run(async () => {
    assert.equal(await o.track(parent.settle(200, "success", true, null, reservation, null)), true);
    let done = false; owner.seal(); void owner.completion.then(() => { done = true; });
    const work = o.track(child.settle(200, "success", true, null, reservation, null));
    await Promise.race([entered.promise, work.then(() => { throw Error("child ended before hold"); })]);
    assert.equal(done, false); assert.notEqual(events[0].id, events[1].id);
    assert.equal(events[0].request_id, events[1].request_id);
    hold.resolve(); await work; assert.equal((await owner.completion).failed, false);
  });
});

test("never-started retention is unused; started write is memoized through the original sink", { timeout: 10_000 }, async t => {
  const o = ownership(t), owner = new ProxyCompletion(), gate = deferred(), entered = deferred();
  let puts = 0, done = false;
  const env = { CONTENT_ARCHIVE: { async put() { puts++; entered.resolve(); await gate.promise; } } };
  const unused = prepareContentRetention(env, auth(), selection(), "unused");
  unused.discardUnused(); unused.discardUnused();
  assert.throws(() => unused.write(), /unused content retention/); assert.equal(puts, 0);
  const archive = prepareContentRetention(env, auth(), selection(), "started");
  o.release(() => { gate.resolve(); owner.seal(); });
  o.track(owner.completion);
  await o.run(async () => {
    const writing = o.track(owner.start(() => archive.write()));
    archive.discardUnused(); assert.equal(archive.write(), writing);
    owner.seal(); void owner.completion.then(() => { done = true; });
    await Promise.race([entered.promise, writing.then(() => { throw Error("write finished before hold"); })]);
    assert.equal(done, false); assert.equal(puts, 1);
    gate.resolve(); await writing; assert.equal((await owner.completion).failed, false);
  });
});

for (const rejects of [false, true]) test(`usage result cannot retire held FIRST cancel; reject=${rejects}`, { timeout: 10_000 }, async t => {
  const o = ownership(t), owner = new ProxyCompletion(), entered = deferred(), cancelEntered = deferred(), cancel = deferred();
  const abort = new AbortController(); let calls = 0, done = false;
  const source = new ReadableStream({ pull() { entered.resolve(); }, cancel() { calls++; cancelEntered.resolve(); return cancel.promise; } }, { highWaterMark: 0 });
  let observed;
  owner.start(() => { observed = observeUsage(new Response(source), new HttpOperation(abort.signal)); return observed.retired; });
  const reader = observed.response.body.getReader();
  o.release(() => { abort.abort(); cancel.resolve(); owner.seal(); });
  o.track(owner.completion);
  t.after(() => reader.releaseLock());
  await o.run(async () => {
    const reading = o.track(outcome(reader.read()));
    owner.seal(); void owner.completion.then(() => { done = true; });
    await Promise.race([entered.promise, reading.then(() => { throw Error("delivery ended before read"); })]);
    abort.abort(undefined);
    await Promise.race([cancelEntered.promise, owner.completion.then(() => { throw Error("completion before cancel"); })]);
    assert.equal((await observed.result).delivery, "canceled");
    assert.equal(done, false); assert.equal(source.locked, true); assert.equal(calls, 1);
    if (rejects) cancel.reject(undefined); else cancel.resolve();
    await owner.completion; await reading;
    assert.equal(source.locked, false); assert.equal(calls, 1);
  });
});

test("ordinary budget denial publishes 402 while original failure accounting still owns the caller charge", { timeout: 10_000 }, async t => {
  const { default: handler } = await import("../index.ts");
  const { usageEnv, proxyKey } = await import("./usage-budget-fixture.mjs");
  const { bodyBudgetCharged } = await import("../body-budget.ts");
  const o = ownership(t), held = deferred(), entered = deferred();
  const env = usageEnv([], { limit: 0, fixedCost: 7, retainContent: false });
  const events = []; let posts = 0, reserves = 0;
  env.OPENAI_API_KEY = "synthetic-key";
  env.USAGE_QUEUE = { async send(event) { events.push(event); entered.resolve(); await held.promise; } };
  env.BUDGET_LEDGER = { idFromName() { reserves++; throw Error("unexpected reserve"); } };
  t.mock.method(globalThis, "fetch", async () => { posts++; throw Error("unexpected provider call"); });
  o.release(() => held.resolve());
  await o.run(async () => {
    const response = await o.track(handler.fetch(new Request("https://router.example/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json", "x-request-id": "ordinary-denial" },
      body: JSON.stringify({ model: "openai/gpt-6-astra", messages: [{ role: "user", content: "x".repeat(1024 * 1024 + 16) }] }),
    }), env, { waitUntil: o.track }).then(async response => ({ status: response.status, body: await response.json() })));
    assert.equal(response.status, 402); assert.equal(response.body.error.code, "budget_exhausted");
    assert.equal(events.length, 1); assert.equal(events[0].request_id, "ordinary-denial");
    assert.equal(events[0].actual_cost_micros, 0); assert.equal(events[0].reserved_cost_micros, 0);
    assert.equal(reserves, 0); assert.equal(posts, 0); assert.ok(bodyBudgetCharged() > 0);
    held.resolve(); // t.after joins the actual accounting and admission-finish roots.
  });
});

for (const mode of ["sse-replay", "sse-normalization", "json-normalization"]) for (const rejects of [false, true]) {
  test(`public stream:true ${mode} retains ORIGINAL FIRST cancel, reject=${rejects}`, { timeout: 10_000 }, async t => {
    const { default: handler } = await import("../index.ts");
    const { usageEnv, proxyKey } = await import("./usage-budget-fixture.mjs");
    const { bodyBudgetCharged } = await import("../body-budget.ts");
    const o = ownership(t), caller = new AbortController(), cancellation = deferred(), cancelEntered = deferred(), readEntered = deferred();
    const queue = deferred(), accountingDone = deferred(), cleanup = deferred(), completed = deferred(), failure = deferred();
    void failure.promise.catch(() => {}); // Actual failing roots are also joined by ownership(t).
    const arrived = phase => Promise.race([phase, failure.promise, completed.promise.then(() => { throw Error("caller completed before held-source assertion"); })]);
    const normalization = mode !== "sse-replay", events = [];
    let cancels = 0, posts = 0, reader, readOutcome;
    const chunk = new TextEncoder().encode(mode === "json-normalization" ? JSON.stringify({ error: { message: "x".repeat(70 * 1024) } })
      : `data: ${JSON.stringify(normalization ? { error: { message: "fixture rejection", type: "rate_limit_error" } }
        : { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "fixture" }, finish_reason: null }] })}\n\n`);
    const original = new ReadableStream({ start(controller) { controller.enqueue(chunk); }, pull() { readEntered.resolve(); },
      cancel() { cancels++; cancelEntered.resolve(); return cancellation.promise; } }, { highWaterMark: 0 });
    const env = usageEnv([], { limit: null, providerLimit: null, fixedCost: 7, retainContent: false });
    env.OPENAI_API_KEY = "synthetic-key";
    env.USAGE_QUEUE = { async send(event) { events.push(event); await queue.promise; } };
    t.mock.method(globalThis, "fetch", async () => { posts++; return new Response(original, {
      status: normalization ? 429 : 200, headers: { "content-type": mode.startsWith("sse") ? "text/event-stream" : "application/json" },
    }); });
    o.release(() => { caller.abort(); queue.resolve(); cancellation.resolve(); cleanup.resolve(); });
    // Pre-registered body ownership also covers an assertion before the first read.
    o.track(cleanup.promise.then(async () => {
      const settled = await readOutcome?.then(() => ({ failed: false }), error => ({ failed: true, error }));
      let unlockFailed = false, unlockError;
      try { reader?.releaseLock(); } catch (error) { unlockFailed = true; unlockError = error; }
      if (unlockFailed) throw new AggregateError(settled?.failed ? [settled.error, unlockError] : [unlockError], "client reader cleanup");
      if (settled?.failed) throw settled.error;
    }));
    const context = { waitUntil(work) {
      o.track(work);
      // The existing terminal continuation returns the actual finalize boolean.
      void work.then(result => {
        if (typeof result === "boolean") accountingDone.resolve(result);
        else if (result && typeof result.failed === "boolean" && typeof result.unused === "boolean") completed.resolve(result);
      }, error => failure.reject(error));
    } };
    await o.run(async () => {
      const response = await o.track(handler.fetch(new Request("https://router.example/v1/chat/completions", {
        method: "POST", signal: caller.signal, headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json", "x-request-id": "stream-completion" },
        body: JSON.stringify({ model: "openai/gpt-6-astra", stream: true, messages: [{ role: "user", content: "x".repeat(1024 * 1024 + 16) }] }),
      }), env, context));
      reader = response.body.getReader(); assert.equal(response.status, normalization ? 429 : 200);
      const first = await o.track(reader.read()); assert.equal(first.done, false);
      if (normalization) {
        const decoder = new TextDecoder(); let text = decoder.decode(first.value, { stream: true });
        for (;;) { const part = await o.track(reader.read()); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
        assert.ok(JSON.parse(text + decoder.decode()).error);
      } else {
        assert.equal(first.value, chunk, "normalization and custody forward the ORIGINAL chunk reference");
        readOutcome = o.track(reader.read().then(() => { throw Error("public pending read unexpectedly fulfilled"); }, error => {
          assert.equal(error, caller.signal.reason);
        }));
        await Promise.race([readEntered.promise, readOutcome.then(() => { throw Error("no original pending read"); })]);
        caller.abort(Error("fixture public cancellation")); await readOutcome;
      }
      await arrived(cancelEntered.promise);
      assert.equal(cancels, 1); assert.equal(original.locked, true); assert.ok(bodyBudgetCharged() > 0);
      queue.resolve(); assert.equal(await arrived(accountingDone.promise), true);
      await tick(); // Completion observers have run; actual accounting is already joined.
      assert.equal(events.length, 1); assert.equal(events[0].request_id, "stream-completion");
      assert.equal(events[0].actual_cost_micros, normalization ? 0 : 7); assert.equal(events[0].status_code, normalization ? 429 : 200); assert.equal(posts, 1);
      assert.equal(original.locked, true); assert.ok(bodyBudgetCharged() > 0, "normalizer wrapper is not ORIGINAL cancellation retirement");
      if (rejects) cancellation.reject(undefined); else cancellation.resolve();
      assert.equal((await completed.promise).failed, false); await tick();
      assert.equal(original.locked, false); assert.equal(cancels, 1); assert.equal(bodyBudgetCharged(), 0);
      // Unconditional teardown joins all actual context roots before releasing the client lock.
    });
  });
}

// UNRUN_CODE_ONLY_HOSTED. The same native setup loads ordinary helpers in a
// fresh process; no application loader or dependency repair is substituted.
test("ordinary ledger and usage imports do not activate private HTTP orchestration", async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const setup = new URL("./typescript-setup.mjs", import.meta.url).href;
  const modules = ["../utils.ts", "../ledgers.ts", "../token-usage.ts"].map(name => new URL(name, import.meta.url).href);
  const script = `import { registerHooks } from 'node:module';
    const seen=[]; const hooks=registerHooks({load(url,context,next){
      if(/\\/(?:http-identity-owner|proxy-response|proxy)\\.ts$/.test(url))seen.push(url);
      return next(url,context);
    }});
    await import(${JSON.stringify(setup)});
    for(const url of ${JSON.stringify(modules)})await import(url);
    hooks.deregister(); if(seen.length)throw Error('ordinary import activated private HTTP: '+seen.join(','));`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { maxBuffer: 1024 * 1024 });
});

test("named request receivers require canonical membership and the exact tuple", async () => {
  const owner = await import("../http-identity-owner.ts"), leaf = await import("../proxy-completion.ts");
  const { bodyBudgetCharged } = await import("../body-budget.ts");
  let effects = 0;
  const env = { get ACCESS_CONTROL() { effects++; throw Error("foreign binding getter"); } };
  const request = new Request("https://fixture.example/v1/chat/completions");
  const cap = owner.beginOwnedHttpRequest(request, env), sink = owner.ownedHttpSinkOwner(cap);
  const receiver = leaf.ownedHttpRequestReceiver(cap), before = bodyBudgetCharged();
  try {
    assert.equal(receiver, leaf.ownedHttpSinkReceiver(sink));
    assert.equal(leaf.ownedHttpRequestReceiver({}), undefined);
    assert.equal(leaf.ownedHttpRevalidationReceiver({}), undefined);
    receiver.checkOwnedHttpRequest(cap, request, env);
    assert.throws(() => receiver.checkOwnedHttpRequest(cap, new Request(request), env));
    assert.throws(() => receiver.checkOwnedHttpRequest({}, request, env));
    assert.throws(() => receiver.growOwnedHttpRequest.call(new owner.OwnedHttpRequestReceiver(), cap, 1024));
    assert.equal(effects, 0); assert.equal(bodyBudgetCharged(), before);
  } finally { await owner.finishOwnedHttpRequest(cap); }
  assert.equal(leaf.ownedHttpRequestReceiver(cap), undefined);
  assert.equal(leaf.ownedHttpSinkReceiver(sink), undefined);
  assert.equal(effects, 0);
});
