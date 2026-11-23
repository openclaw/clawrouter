// Test-only, serialized into the two fixture Workers. No producer Promise,
// resolver, reader, lease or lifecycle method is an input to this projection.
export function createMusicPassiveState(isProxy = () => false) {
  const ids = ["abort_headers", "abort_body", "deadline_body"];
  const fail = () => { throw new Error("invalid passive music state"); };
  const data = value => {
    if (!value || typeof value !== "object" || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
    const out = {};
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !d || !("value" in d)) fail();
      Object.defineProperty(out, key, { value: d.value, enumerable: true });
    }
    return out;
  };
  const exact = (value, keys) => {
    const out = data(value);
    if (Object.keys(out).length !== keys.length || keys.some(key => !Object.hasOwn(out, key))) fail();
    return out;
  };
  const integer = (value, max = 1_000_000_000) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(); return value;
  };
  const boolean = value => { if (typeof value !== "boolean") fail(); return value; };
  const member = (value, values) => { if (!values.includes(value)) fail(); return value; };
  const status = value => value === null ? null : integer(value, 599) >= 100 ? value : fail();
  const signal = value => {
    if (value === null) return null;
    // The original signal's branded getter, never a caller-defined accessor.
    if (isProxy(value) || Object.getOwnPropertyDescriptor(value, "aborted")) fail();
    return boolean(Reflect.apply(Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get, value, []));
  };
  const responseStatus = value => {
    if (value === undefined) return null;
    if (isProxy(value) || Object.getOwnPropertyDescriptor(value, "status")) fail();
    return status(Reflect.apply(Object.getOwnPropertyDescriptor(Response.prototype, "status").get, value, []));
  };
  const list = value => {
    if (!Array.isArray(value) || isProxy(value) || value.length > 1000) fail();
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !("value" in d)) fail();
      out.push(d.value);
    }
    if (Reflect.ownKeys(value).length !== out.length + 1) fail();
    return out;
  };
  const bounded = value => {
    const text = JSON.stringify(value); if (new TextEncoder().encode(text).length > 8192) fail();
    return text;
  };
  const freeze = value => {
    for (const v of Object.values(value)) if (v && typeof v === "object") freeze(v);
    return Object.freeze(value);
  };
  const lifetime = value => {
    const v = exact(value, ["pending", "timerActive", "listenerActive", "timer", "terminal", "finished", "cancelCalls", "cancelReturned", "abortCalls", "abortReturned", "faults"]);
    for (const k of ["pending", "cancelCalls", "cancelReturned", "abortCalls", "abortReturned", "faults"]) integer(v[k], 1000);
    for (const k of ["timerActive", "listenerActive", "finished"]) boolean(v[k]);
    member(v.timer, ["pending", "canceled", "expired"]); member(v.terminal, [null, "abort", "cancel", "failed", "expired"]);
    return v;
  };
  const readiness = (value, id) => {
    const order = ["wait_entered", "resolver_called", "resolver_returned", "wait_returned"];
    const counts = ["matchingPosts", "waitCount", "cancelCalls", "failureCount"];
    const states = ["timer", "notification", "task"];
    const flags = ["cancelReturned", "cancelWhilePending", "expired", "joined", "mapRemoved", "listenerRemoved"];
    const v = exact(value, ["id", ...order, ...counts, ...states, ...flags, "timerRejectionObject"]);
    if (v.id !== id) fail();
    for (const k of order) if (v[k] !== null && integer(v[k], 1_000_000) === 0) fail();
    for (const k of counts) integer(v[k], k === "cancelCalls" ? 1 : 1000);
    for (const k of states) member(v[k], ["unstarted", "pending", "fulfilled", "rejected"]);
    for (const k of flags) boolean(v[k]);
    if (v.timerRejectionObject !== null) boolean(v.timerRejectionObject);
    return v;
  };
  function source(calls, readReady, atMs) {
    const all = list(calls).map(data);
    const rows = ids.map(id => {
      const matches = all.filter(row => row.id === id); if (matches.length > 1) fail();
      const c = matches[0];
      return { id, lifetime: c ? lifetime(c.sourceLifetime) : null,
        aborted: c ? boolean(c.aborted) : null, canceled: c ? boolean(c.canceled) : null, expired: c ? boolean(c.expired) : null,
        returned: c ? Object.hasOwn(c, "sourceReturnReached") ? boolean(c.sourceReturnReached) : false : null,
        readiness: readiness(readReady(id), id) };
    });
    return freeze({ atMs: integer(atMs), rows });
  }
  function validateSource(value) {
    const v = exact(value, ["atMs", "rows"]); integer(v.atMs);
    if (list(v.rows).length !== ids.length) fail();
    const rows = v.rows.map((row, i) => {
      const r = exact(row, ["id", "lifetime", "aborted", "canceled", "expired", "returned", "readiness"]);
      if (r.id !== ids[i]) fail();
      const l = r.lifetime === null ? null : lifetime(r.lifetime);
      for (const k of ["aborted", "canceled", "expired", "returned"]) if (l === null ? r[k] !== null : typeof r[k] !== "boolean") fail();
      return { ...r, lifetime: l, readiness: readiness(r.readiness, r.id) };
    });
    bounded({ atMs: v.atMs, rows }); return freeze({ atMs: v.atMs, rows });
  }
  function local(point, caseId, readyStatus, ingresses, inputs, charged, atMs) {
    member(point, ["readiness", "retirement"]);
    if (point === "readiness" ? !ids.includes(caseId) : caseId !== "none") fail();
    const allIngress = list(ingresses).map(data), allInputs = list(inputs).map(data);
    const rows = ids.map(id => {
      const ins = allIngress.filter(r => r.id === id);
      const outs = allInputs.filter(r => r.binding && data(data(r.binding).row).id === id);
      if (ins.length > 1 || outs.length > 1) fail();
      const ingress = ins[0], input = outs[0];
      if (input && (!ingress || data(input.binding).ingress !== ingresses[allIngress.indexOf(ingress)])) fail();
      return { id, ingressAborted: ingress ? signal(ingress.signal) : null,
        effectiveAborted: input ? signal(data(input.effective).signal) : null,
        responseStatus: ingress ? status(ingress.responseStatus ?? null) : null,
        upstreamStatus: input ? responseStatus(input.response) : null };
    });
    return freeze({ point, caseId, readyStatus: status(readyStatus), atMs: integer(atMs), charged: integer(charged), rows });
  }
  function compact(local, origin, receivedMs, route, stateFaults = 0) {
    member(route, ["native", "manifest"]); integer(stateFaults, 1000);
    if (origin === null ? stateFaults === 0 : stateFaults !== 0) fail();
    if (origin !== null) origin = validateSource(origin);
    local = exact(local, ["point", "caseId", "readyStatus", "atMs", "charged", "rows"]);
    member(local.point, ["readiness", "retirement"]);
    if (local.point === "readiness" ? !ids.includes(local.caseId) : local.caseId !== "none") fail();
    status(local.readyStatus); integer(local.atMs); integer(local.charged);
    if (list(local.rows).length !== ids.length) fail();
    const localRows = list(local.rows).map((row, i) => {
      const r = exact(row, ["id", "ingressAborted", "effectiveAborted", "responseStatus", "upstreamStatus"]);
      if (r.id !== ids[i]) fail();
      for (const key of ["ingressAborted", "effectiveAborted"]) if (r[key] !== null) boolean(r[key]);
      status(r.responseStatus); status(r.upstreamStatus); return r;
    });
    integer(receivedMs); if (receivedMs < local.atMs) fail();
    const r = { v: 1, layer: "outer", route, caseId: local.caseId, phase: "native_state", role: "primary", outcome: "unknown", category: "none",
      point: local.point, localMs: local.atMs, sourceMs: origin?.atMs ?? null, receivedMs, charged: local.charged, httpStatus: local.readyStatus, stateFaults };
    // h/b/d = header/body/deadline. I/E=current observed abort, S=actual
    // router HTTP status, U=actual upstream HTTP status; null means unobserved.
    // L bits: owner,timer,listener,finished,aborted,canceled,expired,returned,
    // abort-callback-returned,cancel-callback-returned. T=terminal index +
    // 8*timer index. P=pending originals; F=source faults; D=readiness faults.
    // R bits0..7: entered,called,returned,resumed,expired,joined,map removed,
    // listener removed; bits8..13: timer,notification,task (2 bits each).
    // Full counters/order stamps stay in the closed source response, not in
    // this compact observation. No bit classifies a rejection or proves cause.
    for (const [i, p] of ["h", "b", "d"].entries()) {
      const a = localRows[i], s = origin?.rows[i], l = s?.lifetime, q = s?.readiness;
      r[p + "I"] = a.ingressAborted; r[p + "E"] = a.effectiveAborted; r[p + "S"] = a.responseStatus; r[p + "U"] = a.upstreamStatus;
      r[p + "L"] = l ? [true, l.timerActive, l.listenerActive, l.finished, s.aborted, s.canceled, s.expired, s.returned, l.abortReturned > 0, l.cancelReturned > 0].reduce((n, v, bit) => n + (v ? 2 ** bit : 0), 0) : null;
      r[p + "T"] = l ? [null, "abort", "cancel", "failed", "expired"].indexOf(l.terminal) + 8 * ["pending", "canceled", "expired"].indexOf(l.timer) : null;
      r[p + "P"] = l?.pending ?? null; r[p + "F"] = l?.faults ?? null; r[p + "D"] = q?.failureCount ?? null;
      r[p + "R"] = q ? [q.wait_entered !== null, q.resolver_called !== null, q.resolver_returned !== null, q.wait_returned !== null, q.expired, q.joined, q.mapRemoved, q.listenerRemoved].reduce((n, v, bit) => n + (v ? 2 ** bit : 0), 0)
        + [q.timer, q.notification, q.task].reduce((n, v, index) => n + ["unstarted", "pending", "fulfilled", "rejected"].indexOf(v) * 2 ** (8 + 2 * index), 0) : null;
    }
    if (new TextEncoder().encode(JSON.stringify(r)).length > 640) fail();
    return freeze(r);
  }
  return { ids, source, validateSource, local, compact, bounded, responseStatus };
}

// Await only this small control response; never wait for the observed producers.
// This is the existing readiness/control bound, not a renewed SDK deadline.
export async function readMusicPassiveResponse(fetchOriginal, url, protocol, runtime = {
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle),
}) {
  const controller = new AbortController(), errors = []; let timer, reader, closed, value;
  try {
    timer = runtime.setTimeout(() => controller.abort(new Error("passive observation bound expired")), 10000);
    const response = await fetchOriginal(url, { method: "GET", signal: controller.signal, redirect: "manual" });
    const status = protocol.responseStatus(response), body = response.body;
    if (body) reader = body.getReader();
    // Observe this exact diagnostic reader's original closed Promise at
    // acquisition; join it independently even when read/cancel also reject.
    if (reader) closed = reader.closed.then(() => ({ status: "fulfilled" }), reason => ({ status: "rejected", reason }));
    if (status !== 200) throw new Error("passive observation HTTP failure");
    if (!reader) throw new Error("passive observation body missing");
    const chunks = []; let bytes = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > 8192) throw new Error("passive observation byte bound exceeded");
      chunks.push(part.value);
    }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(joined), parsed = JSON.parse(text);
    // The producer emits exactly JSON.stringify; this rejects duplicate keys
    // and alternate framing before admitting the closed transport object.
    if (JSON.stringify(parsed) !== text) throw new Error("noncanonical passive observation");
    value = protocol.validateSource(parsed);
  } catch (error) { errors.push(error); }
  finally {
    if (reader) {
      if (errors.length) try { await reader.cancel(); } catch (error) { errors.push(error); }
      if (closed) {
        const outcome = await closed;
        if (outcome.status === "rejected") errors.push(outcome.reason);
      }
      try { reader.releaseLock(); } catch (error) { errors.push(error); }
    }
    try { runtime.clearTimeout(timer); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "passive observation failed");
  return value;
}

export async function captureMusicPassiveState(store, faults, point, freezeLocal, readSource, compact, now) {
  if (store.has(point)) return; // Keep the first snapshot, including a failed observation.
  store.set(point, null);
  let local;
  try {
    local = freezeLocal(); // MUST precede the first cross-Worker await.
    store.set(point, Object.freeze({ local, origin: null, receivedMs: null }));
    const origin = await readSource();
    store.set(point, Object.freeze({ local, origin, receivedMs: now() }));
    const captured = store.get(point);
    return compact(captured.local, captured.origin, captured.receivedMs);
  } catch (error) {
    faults.push(error);
    if (local) try {
      const receivedMs = now(); store.set(point, Object.freeze({ local, origin: null, receivedMs }));
      return compact(local, null, receivedMs, 1);
    } catch (observerError) { faults.push(observerError); }
  }
}
