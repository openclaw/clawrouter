import { sqliteFixture } from "./sqlite-storage.mjs";
import { PolicyBindingIndexObject } from "../authority.ts";
import { accessBytesResponse } from "./access-byte-fixture.mjs";

export function continuationAuthority(t, env = {}) {
  const objects = new Map();
  const namespace = {
    objects, beforeFetch: null,
    idFromName: name => name,
    get(name) {
      if (!objects.has(name)) {
        const { db, sql, transactionSync } = sqliteFixture(t);
        const fixture = { db, scheduled: null, beforeSchedule: null };
        const storage = {
          sql,
          transactionSync,
          async setAlarm(value) { await fixture.beforeSchedule?.(); fixture.scheduled = value; },
          async getAlarm() { return fixture.scheduled; },
          async deleteAlarm() { fixture.scheduled = null; },
        };
        fixture.object = new PolicyBindingIndexObject({ storage }, env);
        fixture.restart = () => { fixture.object = new PolicyBindingIndexObject({ storage }, env); };
        objects.set(name, fixture);
      }
      return { async fetch(url, init) {
        const request = new Request(url, init);
        await namespace.beforeFetch?.(name, request);
        if (!request.headers.has("x-clawrouter-identity-admission")) return objects.get(name).object.fetch(request);
        const response = await objects.get(name).object.fetch(new Request(request, {
          body: accessBytesResponse(init.body, "").body, duplex: "half",
        }));
        return accessBytesResponse(await response.text(), "", { status: response.status, headers: response.headers });
      } };
    },
  };
  return namespace;
}
