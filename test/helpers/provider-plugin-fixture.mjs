import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

export function providerPluginFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "provider-plugin-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(fileURLToPath(new URL("../../examples/provider-plugin/", import.meta.url)), root, { recursive: true });
  const change = (file, yaml, update) => {
    const path = join(root, file);
    const value = yaml ? parse(readFileSync(path, "utf8")) : JSON.parse(readFileSync(path, "utf8"));
    update(value);
    writeFileSync(path, yaml ? stringify(value) : JSON.stringify(value));
  };
  return { root, descriptor: join(root, "clawrouter.plugin.json"),
    scenario: update => change("fixtures/request.json", false, update),
    manifest: update => change("example.provider.yaml", true, update),
    metadata: update => change("clawrouter.plugin.json", false, update) };
}
