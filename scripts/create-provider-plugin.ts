import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseProviderPluginDescriptor, providerPluginFiles } from "../packages/provider-plugin-contract/src/index.ts";
import { loadProviderPlugin } from "./provider-plugin-loader.ts";

/** Generate files only. The caller must explicitly compile and admit the provider. */
export function createProviderPlugin(id: string, destination: string): string {
  const source = fileURLToPath(new URL("../examples/provider-plugin/", import.meta.url));
  const template = loadProviderPlugin(join(source, "clawrouter.plugin.json"));
  const descriptor = parseProviderPluginDescriptor({ ...template.descriptor, id, manifest: `${id}.provider.yaml` });
  if (typeof destination !== "string" || !destination.trim()) throw new Error("a new destination directory is required");
  const root = resolve(destination);
  const title = id.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
  const configKey = `${id.replaceAll("-", "_").toUpperCase()}_API_KEY`;
  // Prepare the full trusted template before creating anything in the target.
  const files = providerPluginFiles(template.descriptor).map(path => {
    let bytes: string | Buffer = readFileSync(join(source, path));
    const targetPath = path === template.descriptor.manifest ? descriptor.manifest : path;
    if (path === template.descriptor.manifest) {
      bytes = bytes.toString("utf8").replaceAll("EXAMPLE_API_KEY", configKey).replaceAll("example", id).replace("displayName: Example", `displayName: ${title}`);
    } else if (path === template.descriptor.documentation) {
      bytes = `# ${title} provider plugin\n\n` +
        `This is a starter integration, not a configured live service. Replace the\n` +
        `reserved api.${id}.invalid URL and example endpoint with documented provider\n` +
        `behavior. Provision ${configKey} outside this package. Never add secrets\n` +
        `to the manifest, fixtures, docs, or Git history.\n\n` +
        `Files: clawrouter.plugin.json describes the package; ${id}.provider.yaml\n` +
        `owns execution declarations; assets/ contains branding; fixtures/ contains\n` +
        `synthetic request/response data. Replace the license placeholder before distribution.\n\n` +
        `From a ClawRouter checkout, compile this package with:\n\n` +
        `    node scripts/compile-providers.mjs --plugin <package-dir>/clawrouter.plugin.json\n\n` +
        `Package creation does not register, enable, or deploy a provider. See\n` +
        `https://github.com/openclaw/clawrouter/blob/main/docs/provider-plugins.md\n`;
    }
    return { path: targetPath, bytes };
  });
  // Non-recursive and exclusive: even an existing empty directory is not adopted.
  mkdirSync(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.bytes, { flag: "wx" });
  }
  // A failed write leaves no complete descriptor advertising a partial package.
  const descriptorPath = join(root, "clawrouter.plugin.json");
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx" });
  return descriptorPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [id, destination, ...extra] = process.argv.slice(2);
  if (!id || !destination || extra.length) throw new Error("usage: create-provider-plugin <provider-id> <new-directory>");
  process.stdout.write(`${createProviderPlugin(id, destination)}\n`);
}
