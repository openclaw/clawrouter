import { spawnSync } from "node:child_process";

const bucket = process.env.CLAWROUTER_CONTENT_BUCKET ?? "clawrouter-content";

runAllowExists(["r2", "bucket", "create", bucket]);
runAllowExists([
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
]);
console.log(`CONTENT_ARCHIVE=${bucket} retention=30d`);

function runAllowExists(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0) {
    process.stdout.write(output);
    return;
  }
  if (/already exists|already has|duplicate/i.test(output)) {
    console.log(`${args.join(" ")} already configured`);
    return;
  }
  throw new Error(output || `wrangler ${args.join(" ")} failed`);
}
