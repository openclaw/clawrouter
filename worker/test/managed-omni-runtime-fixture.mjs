import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./managed-runtime-fixture.mjs";
const { managedLifecycleAdapter } = await import("../managed-lifecycle-adapters.ts");
const { googleOmniVideoManagedAdapter: codec } = await import("../managed-google-omni.ts");
export const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google-omni/video.json", import.meta.url)));
export const adapter = managedLifecycleAdapter("replicate.predictions"), path = "/v1/native/replicate/interactions";
export const control = `${path}/${wire.pending.id}`;
const overrides = new WeakMap();
export function override(t, name, value) {
  let originals = overrides.get(t);
  if (!originals) {
    originals = new Map(); overrides.set(t, originals);
    t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(adapter, key, descriptor); else delete adapter[key]; } });
  }
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(adapter, name));
  Object.defineProperty(adapter, name, { configurable: true, writable: true, value });
}
export async function setup(t, options = {}) {
  // Exercise the actual source codec through the existing registered controller;
  // this seam does not activate a Google declaration or registry entry.
  const f = await fixture(t, { ...options, configure(provider) {
    const create = provider.endpoints.find(e => e.id === "predictions"), get = provider.endpoints.find(e => e.id === "prediction"), cancel = provider.endpoints.find(e => e.id === "prediction_cancel");
    create.path = "/interactions";
    for (const [endpoint, suffix] of [[get, ""], [cancel, "/cancel"]]) {
      endpoint.path = "/interactions/${interaction_id}" + suffix; endpoint.path_params = ["interaction_id"]; endpoint.path_param_styles = {};
    }
    provider.base_urls = { default: "https://generativelanguage.googleapis.com/v1beta" };
  } });
  for (const key of ["prepare", "identify", "validateId", "control", "read", "rewrite"]) override(t, key, codec[key]);
  override(t, "retainedParams", ["background", "store"]);
  override(t, "allowedControls", params => {
    assert.ok(["true", "false"].includes(params.background) && ["true", "false"].includes(params.store));
    assert.ok(params.background !== "true" || params.store === "true");
    return params.store !== "true" ? [] : params.background === "true" ? ["retrieve", "cancel"] : ["retrieve"];
  });
  f.upstream = () => Response.json(wire.retrieved);
  return f;
}
export const body = flags => ({ ...wire.requests[0], ...flags });
