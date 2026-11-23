// Embedded only by the Cloudflare fixture. Observe the original clone/tee; never
// consume, cancel, unlock, or replace any product on the consumer's behalf.
type CloudflareCloneScope = { url: string; credential: string };
type CloudflareCloneAcquisition = {
  owner: unknown; acquired: boolean; hooked: boolean; releaseCalls: number;
  returned: Promise<unknown>; result?: { response: Response };
};
type CloudflareCloneBody = {
  body: ReadableStream<unknown>; owner: unknown; acquisition?: CloudflareCloneAcquisition;
};
type CloudflareCloneReader = CloudflareCloneBody & {
  reader: ReadableStreamDefaultReader<unknown>; receivedBody: unknown; closed: Promise<unknown>;
  unlocks: number; unlocked: number; eof: boolean; unlockInvocations: number[]; unlockReturns: number[];
};
type CloudflareCloneOperation = {
  kind: string; owner: unknown; acquisition?: unknown; reader?: unknown; pending?: unknown;
  state: string; original?: unknown; receiver?: unknown; operands?: unknown[]; value?: unknown; invoked: number; settled?: number;
};
type CloudflareCloneRecord = {
  response: Response; owner: unknown; acquisition?: CloudflareCloneAcquisition;
  receiver: unknown; operands: unknown[]; original: Response["clone"];
  parent?: ReadableStream<unknown>; left?: ReadableStream<unknown>; right?: ReadableStream<unknown>;
  result?: Response; status?: number; beforeUnlocked?: boolean; operation?: CloudflareCloneOperation;
};
function createCloudflareCloneObserver(context: {
  sdk?: { bindings: unknown[]; cloudflareClone?: CloudflareCloneScope };
  operations: CloudflareCloneOperation[]; errors: unknown[]; bodies: CloudflareCloneBody[];
  readers: CloudflareCloneReader[]; guards: CloudflareCloneAcquisition[];
  safe: (callback: () => void) => void;
  patch: (target: object, key: string, replacement: (this: unknown, ...args: unknown[]) => unknown) => void;
  invoke: (kind: string, original: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[], owner: unknown,
    settled?: (value: unknown) => void, identity?: object) => unknown;
  response: (value: Response, owner: unknown, acquisition?: CloudflareCloneAcquisition) => Response;
}) {
  const { operations, errors, bodies, readers, guards, safe, patch, invoke } = context;
  const responses = new WeakMap<Response, { owner: unknown; acquisition?: CloudflareCloneAcquisition }>();
  const clones: CloudflareCloneRecord[] = [];
  const own = (value: unknown, key: string) => {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  };
  function expectedOwner(owner: unknown) {
    const scope = context.sdk?.cloudflareClone;
    return !!scope && context.sdk!.bindings.filter(value => value === owner).length === 1
      && own(owner, "id") === "unpriced" && own(owner, "kind") === "chat"
      && own(owner, "method") === "POST" && own(owner, "url") === scope.url
      && own(owner, "credential") === scope.credential && own(owner, "header") === "x-api-key"
      && own(owner, "prefix") === "" && own(owner, "claimed") === true;
  }
  function observe(value: Response, owner: unknown, acquisition?: CloudflareCloneAcquisition) {
    const known = responses.get(value);
    if (known) {
      if (known.owner !== owner || known.acquisition !== acquisition) throw new Error("foreign Cloudflare clone response");
      return;
    }
    responses.set(value, { owner, acquisition });
    const original = value.clone;
    patch(value, "clone", function (this: unknown, ...args: unknown[]) {
      const record: CloudflareCloneRecord = { response: value, owner, acquisition, receiver: this, operands: args, original };
      clones.push(record);
      safe(() => {
        record.parent = value.body ?? undefined; record.status = value.status;
        record.beforeUnlocked = record.parent?.locked === false;
        if (this !== value || clones.length !== 1 || !expectedOwner(owner)
          || !acquisition || acquisition.result?.response !== value || record.status !== 400
          || !bodies.some(row => row.body === record.parent && row.owner === owner && row.acquisition === acquisition)) {
          throw new Error("Cloudflare clone admission mismatch");
        }
      });
      // invoke retains a synchronous throw (including undefined) and returns the
      // identical original Response. Observer faults are separate and sticky.
      const result = invoke("response.clone", original, this, args, owner, undefined, { acquisition });
      safe(() => {
        record.operation = operations.find(op => op.kind === "response.clone" && op.receiver === this && op.operands === args);
        record.left = value.body ?? undefined;
        if (!result || typeof result !== "object") throw new Error("missing Cloudflare clone result");
        record.result = result as Response; record.right = record.result.body ?? undefined;
        if (!record.parent || !record.left || !record.right || result === value
          || record.left === record.parent || record.right === record.parent || record.left === record.right
          || value.status !== record.status || record.result.status !== record.status) {
          throw new Error("invalid Cloudflare clone topology");
        }
      });
      // Both post-clone bodies are originals. Retain the pre-clone body row too.
      safe(() => { if (record.left && record.left !== record.parent) context.response(value, owner, acquisition); });
      safe(() => { if (record.result && record.right && record.right !== record.parent && record.right !== record.left) context.response(record.result, owner, acquisition); });
      return result;
    });
  }
  function leaf(body: ReadableStream<unknown>, record: CloudflareCloneRecord) {
    const rows = bodies.filter(row => row.body === body), consumers = readers.filter(row => row.body === body);
    if (rows.length !== 1 || consumers.length !== 1) return false;
    const row = rows[0]!, reader = consumers[0]!;
    if (row.owner !== record.owner || row.acquisition !== record.acquisition
      || reader.owner !== record.owner || reader.acquisition !== record.acquisition || reader.receivedBody !== body
      || body.locked || reader.eof !== true || reader.unlocks !== 1 || reader.unlocked !== 1
      || reader.unlockInvocations.length !== 1 || reader.unlockReturns.length !== 1) return false;
    const work = operations.filter(op => op.reader === reader);
    const closed = work.filter(op => op.kind === "reader.closed"), reads = work.filter(op => op.kind === "reader.read");
    const unlocks = work.filter(op => op.kind === "reader.unlock");
    return closed.length === 1 && closed[0]!.pending === reader.closed && closed[0]!.state === "fulfilled"
      && reads.length > 0 && reads.every(op => op.receiver === reader.reader && op.state === "fulfilled")
      && unlocks.length === 1 && unlocks[0]!.receiver === reader.reader && unlocks[0]!.state === "fulfilled"
      && !work.some(op => op.kind === "reader.cancel")
      && !operations.some(op => op.kind === "body.cancel" && op.receiver === body)
      && work.every(op => op.owner === record.owner && op.acquisition === record.acquisition && op.state === "fulfilled")
      && [...closed, ...reads].every(op => typeof op.settled === "number" && op.settled < reader.unlockInvocations[0]!)
      && reader.unlockInvocations[0]! < reader.unlockReturns[0]!;
  }
  function transferred(row: CloudflareCloneBody) {
    if (clones.length !== 1 || errors.length) return false;
    const record = clones[0]!, acquisition = record.acquisition, op = record.operation;
    if (!expectedOwner(record.owner) || row.body !== record.parent || row.owner !== record.owner || row.acquisition !== acquisition
      || !acquisition || guards.filter(value => value === acquisition).length !== 1
      || guards.filter(value => value.owner === record.owner).length !== 1 || acquisition.owner !== record.owner
      || !acquisition.acquired || !acquisition.hooked || acquisition.releaseCalls !== 1
      || acquisition.result?.response !== record.response || record.receiver !== record.response
      || record.beforeUnlocked !== true || record.status !== 400 || !record.left || !record.right || !record.result
      || record.response.body !== record.left || record.result.body !== record.right
      || record.left === record.parent || record.right === record.parent || record.left === record.right
      || record.response.status !== 400 || record.result.status !== 400
      || !op || op.state !== "fulfilled" || op.original !== record.original || op.value !== record.result || op.receiver !== record.response
      || op.operands !== record.operands || op.owner !== record.owner || op.acquisition !== acquisition
      || readers.some(reader => reader.body === record.parent)
      || operations.some(item => item.kind === "body.cancel" && item.receiver === record.parent)) return false;
    const work = operations.filter(item => item.owner === record.owner || item.acquisition === acquisition);
    const acquired = work.filter(item => item.kind === "acquire"), releases = work.filter(item => item.kind === "release");
    return acquired.length === 1 && acquired[0]!.pending === acquisition.returned && acquired[0]!.value === acquisition.result
      && releases.length === 1 && !!releases[0]!.pending && typeof (releases[0]!.pending as Promise<unknown>).then === "function"
      && work.every(item => item.owner === record.owner && item.acquisition === acquisition && item.state === "fulfilled")
      && leaf(record.left, record) && leaf(record.right, record);
  }
  function diagnostic() {
    const bounded = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 9999 ? n : null;
    const index = (body?: ReadableStream<unknown>) => body ? bodies.findIndex(row => row.body === body) : -1;
    return {
      v: 1, cloneCount: bounded(clones.length), bodyCount: bounded(bodies.length), errorCount: bounded(errors.length),
      // Parent/left/right indices, receiver binding, original fulfilled return,
      // expected status, and admitted parent disposition. No payload or reasons.
      clones: clones.slice(0, 4).map(row => [index(row.parent), index(row.left), index(row.right),
        Number(row.receiver === row.response), Number(row.operation?.state === "fulfilled" && row.operation.value === row.result),
        Number(row.status === 400), Number(bodies.some(body => body.body === row.parent && transferred(body)))]),
      omittedClones: bounded(Math.max(0, clones.length - 4)),
      // Body index, expected owner, locked, readers, EOF, fulfilled closed,
      // unlock returns, pending, rejected/thrown. Totals retain omitted rows.
      bodies: bodies.slice(0, 16).map((body, i) => {
        const consumers = readers.filter(row => row.body === body.body), work = operations.filter(op => consumers.includes(op.reader as CloudflareCloneReader));
        return [i, Number(expectedOwner(body.owner)), Number(body.body.locked), bounded(consumers.length),
          bounded(consumers.filter(row => row.eof).length), bounded(work.filter(op => op.kind === "reader.closed" && op.state === "fulfilled").length),
          bounded(consumers.reduce((n, row) => n + row.unlocked, 0)), bounded(work.filter(op => op.state === "pending").length),
          bounded(work.filter(op => op.state === "rejected" || op.state === "sync_throw").length)];
      }),
      omittedBodies: bounded(Math.max(0, bodies.length - 16)),
    };
  }
  function joinedParents() {
    const admitted = new Set<CloudflareCloneBody>();
    // Run after the original joins and before their error ledger is copied.
    // A projection failure is independent, including a falsey thrown value.
    safe(() => { for (const row of bodies) if (transferred(row)) admitted.add(row); });
    if (errors.length) admitted.clear();
    return admitted;
  }
  return { observe, joinedParents, diagnostic };
}
async function joinCloudflareLifetime(lifetime: { join: () => Promise<void>; cloneDiagnostic: () => unknown }, report: (line: string) => unknown) {
  try { await lifetime.join(); }
  catch (original) {
    await preserveFailures(() => { throw original; }, [() => {
      const line = "CLOUDFLARE_CLONE_STATE " + JSON.stringify(lifetime.cloneDiagnostic());
      if (new TextEncoder().encode(line).byteLength > 4096) throw new Error("Cloudflare clone diagnostic bound");
      report(line);
    }]);
  }
}
