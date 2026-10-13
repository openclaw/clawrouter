import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDeploymentMutation,
  deploymentTarget,
} from "./deployment-profile.mjs";

const deployment = deploymentTarget();
const bucket = deployment.contentBucketName;

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  assertDeploymentMutation(deployment);
  provisionContentStorage(bucket);
  console.log(`CONTENT_ARCHIVE=${bucket} retention=30d`);
}

export function provisionContentStorage(bucket, run = runWrangler) {
  run(["r2", "bucket", "create", bucket], { allowExisting: true });
  run([
    "r2",
    "bucket",
    "lifecycle",
    "add",
    bucket,
    "request-content-v1-30-days",
    "v1/",
    "--expire-days",
    "30",
    "-y",
  ], { allowExisting: true });
  assertContentLifecycle(run(["r2", "bucket", "lifecycle", "list", bucket]), bucket);
}

function runWrangler(args, { allowExisting = false } = {}) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0) {
    process.stdout.write(output);
    return result.stdout ?? "";
  }
  if (allowExisting && isAlreadyConfigured(output)) {
    console.log(`${args.join(" ")} already configured`);
    return;
  }
  throw new Error(output || `wrangler ${args.join(" ")} failed`);
}

export function assertContentLifecycle(output, bucket) {
  // Wrangler 4 emits LF-separated fields, padded to ten columns. Require full
  // blocks: trimming values or ignoring continuation lines can change a prefix.
  // Colors are disabled at the producer so literal escape bytes stay significant.
  const blocks = [...output.matchAll(/^name: {5}(.*)\nenabled: {2}(.*)\nprefix: {3}(.*)\naction: {3}(.*)(?=\n\n|\n?(?![\s\S]))/gmu)];
  const rules = blocks.filter(([, name]) => name === "request-content-v1-30-days");
  if (blocks.length !== (output.match(/^name:/gmu) ?? []).length ||
    rules.length !== 1 || rules[0][2] !== "Yes" || rules[0][3] !== "v1/" ||
    !rules[0][4].split(", ").includes("Expire objects after 30 days")) {
    throw new Error(`Content lifecycle verification failed for ${bucket}: expected one enabled request-content-v1-30-days rule for v1/ expiring after 30 days. Review the existing bucket rules; no rule was replaced.`);
  }
}

export function isAlreadyConfigured(output) {
  return /already exists|already has|duplicate|rule ids must be unique/i.test(output);
}
