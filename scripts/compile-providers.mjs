import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadProviderManifestInputs, parseProviderCompilerArgs } from "./provider-manifest-inputs.mjs";
import { compileProviderSnapshot } from "./provider-compiler.mjs";

export { compileProviderSnapshot };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { manifestPaths, pluginPaths, output } = parseProviderCompilerArgs(process.argv.slice(2));
  const manifests = loadProviderManifestInputs(manifestPaths, pluginPaths);
  const snapshot = compileProviderSnapshot(manifests);
  const encoded = output ? `${JSON.stringify(snapshot)}\n` : `${JSON.stringify(snapshot, null, 2)}\n`;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, encoded);
  } else {
    process.stdout.write(encoded);
  }
}
