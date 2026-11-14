import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const packagePath = require.resolve("typescript/package.json");
const tsc = resolve(dirname(packagePath), JSON.parse(readFileSync(packagePath, "utf8")).bin.tsc);

function compile(root, name, compilerOptions, files) {
  const config = join(root, `${name}.json`);
  writeFileSync(config, JSON.stringify({ compilerOptions, files }));
  execFileSync(process.execPath, [tsc, "--project", config], { cwd: root, encoding: "utf8", timeout: 30_000, stdio: "pipe" });
}

test("compiled provider declarations build and typecheck without client or Worker contracts", t => {
  const root = mkdtempSync(join(tmpdir(), "provider-snapshot-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "declarations");
  const options = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022"],
    types: [], strict: true, allowImportingTsExtensions: true };
  compile(root, "build", { ...options, declaration: true, emitDeclarationOnly: true, rootDir: repo, outDir: output },
    [join(repo, "shared/provider-snapshot.ts")]);
  const files = readdirSync(output, { recursive: true }).map(file => file.replaceAll("\\", "/"));
  assert.ok(files.includes("shared/provider-snapshot.d.ts"));
  assert.ok(files.includes("shared/provider-model.d.ts"));
  assert.ok(!files.includes("shared/contracts.d.ts"), "the client API must not own compiled-provider declarations");
  assert.ok(!files.some(file => /^(worker|admin)\//.test(file)), "the declaration graph must not depend on a runtime host");

  // This consumer imports emitted declarations without repository ambient types.
  const consumer = join(root, "consumer.ts");
  writeFileSync(consumer, `
import type { ProviderSnapshot, CompiledProvider, CompiledQuotaProbe } from "./declarations/shared/provider-snapshot.js";
import type { GrantAccount, GrantExtraUsage } from "./declarations/shared/provider-observations.js";
declare const snapshot: ProviderSnapshot;
const provider: CompiledProvider = snapshot.providers[0];
const facts: NonNullable<CompiledQuotaProbe["facts"]> = { account: { email: "/email" }, extraUsage: { currency: "/currency" } };
const account: GrantAccount = { displayName: "Synthetic account", extraUsageEnabled: false };
const usage: GrantExtraUsage = { usedCredits: 0, spendLimitReached: false };
export { provider, facts, account, usage };
`);
  compile(root, "consumer", { ...options, noEmit: true }, [consumer]);
});
