import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeInputPublicationPolicy as normalize, readInputPublicationPolicy as read,
  allowsInputPublicationAndForwarding as allows,
} from "../../shared/input-publication.ts";

const now = Date.parse("2026-11-04T00:00:00Z");
const pro = "openrouter/google/lyria-3-pro-preview", clip = "openrouter/google/lyria-3-clip-preview";
const row = (modelId = pro, overrides = {}) => ({ providerId: "openrouter", endpointId: "music_generate", modelId,
  publish: true, forward: true, expiresAt: "2026-11-05T00:00:00.000Z", ...overrides });
const policy = (...allow) => ({ version: "clawrouter.input-publication.v1", allow });
const permitted = (value, at = now) => allows(value, "openrouter", "music_generate", pro, at);

test("absent, null and unrelated permissions never authorize publication or forwarding", () => {
  for (const value of [undefined, null, true, false, [], { retainRequestContent: true },
    { upstreamRetention: { version: "clawrouter.upstream-retention.v1", allow: [{ providerId: "openrouter", protocol: "openrouter.music" }] } },
    { environmentFallback: true }, { inputProfile: "pixverse.image_create" }]) {
    assert.equal(read(value, now), null);
    assert.equal(permitted(value), false);
  }
  assert.equal(normalize(null, now), null);
  assert.deepEqual(normalize(policy(), now), policy());
  assert.equal(permitted(policy()), false);
});

test("normalization canonicalizes entry order and UTC precision without sharing mutable inputs", () => {
  const input = policy(row(pro, { expiresAt: "2026-11-05T00:00:00Z" }), row(clip, { publish: false }));
  const expected = policy(row(clip, { publish: false }), row());
  const result = normalize(input, now);
  assert.deepEqual(result, expected);
  assert.deepEqual(normalize({ allow: [...input.allow].reverse(), version: input.version }, now), expected);
  assert.notEqual(result.allow, input.allow);
  assert.notEqual(result.allow[1], input.allow[0]);
  input.allow[0].publish = false;
  assert.equal(result.allow[1].publish, true);
});

test("both booleans are explicit and independent; combined flow requires both for the selected route", () => {
  for (const publish of [false, true]) for (const forward of [false, true]) {
    const input = policy(row(pro, { publish, forward }));
    assert.equal(read(input, now).allow[0].publish, publish);
    assert.equal(read(input, now).allow[0].forward, forward);
    assert.equal(permitted(input), publish && forward);
  }
  for (const target of [["google", "music_generate", pro], ["openrouter", "chat", pro], ["openrouter", "music_generate", clip],
    ["openrouter", "music_generate", "google/lyria-3-pro-preview"]]) assert.equal(allows(policy(row()), ...target, now), false);
});

test("expiry is checked again at use; an invalid or expired entry closes the whole record", () => {
  const input = policy(row());
  const expiry = Date.parse(input.allow[0].expiresAt);
  assert.equal(permitted(input, expiry - 1), true);
  assert.equal(permitted(input, expiry), false);
  assert.equal(permitted(input, expiry + 1), false);
  assert.equal(read(policy(row(), row(clip, { expiresAt: "2026-11-03T00:00:00Z" })), now), null);
  for (const clock of [NaN, Infinity, -Infinity]) assert.equal(permitted(input, clock), false);
});

for (const [name, value] of [
  ["unknown version", { ...policy(row()), version: "clawrouter.input-publication.v2" }],
  ["unknown root field", { ...policy(row()), retention: true }],
  ["missing version", { allow: [row()] }],
  ["non-array allow", { ...policy(row()), allow: row() }],
  ["more than two entries", policy(row(), row(clip), row())],
  ["duplicate model even with different permissions", policy(row(), row(pro, { publish: false }))],
  ["unknown entry field", policy({ ...row(), destination: "https://example.com" })],
  ["foreign provider", policy(row(pro, { providerId: "google" }))],
  ["foreign endpoint", policy(row(pro, { endpointId: "chat" }))],
  ["unknown model", policy(row("openrouter/google/lyria-4"))],
  ["missing publish", policy(Object.fromEntries(Object.entries(row()).filter(([key]) => key !== "publish")))],
  ["string publish", policy(row(pro, { publish: "true" }))],
  ["numeric forward", policy(row(pro, { forward: 1 }))],
]) test(`closed permission record rejects ${name}`, () => {
  assert.throws(() => normalize(value, now), /inputPublication/);
  assert.equal(read(value, now), null);
  assert.equal(permitted(value), false);
});

test("UTC expiry rejects invalid calendar dates, offsets, normalization and nonfinite input", () => {
  for (const expiresAt of [undefined, null, Infinity, "Infinity", "2027-02-29T00:00:00Z", "2026-11-05T24:00:00Z",
    "2026-11-05", "2026-11-05T00:00:00", "2026-11-05T00:00:00+00:00", "2026-11-05T00:00:00.1Z",
    "2026-11-05T00:00:00.0000Z", "2026-11-05T00:00:00Z\n", " 2026-11-05T00:00:00Z", "+010000-01-01T00:00:00Z"]) {
    assert.throws(() => normalize(policy(row(pro, { expiresAt })), now), /inputPublication/);
    assert.equal(permitted(policy(row(pro, { expiresAt }))), false);
  }
  assert.equal(permitted(policy(row(pro, { expiresAt: "2028-02-29T00:00:00.001Z" }))), true);
});
