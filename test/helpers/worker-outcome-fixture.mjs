import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export function createWorkerOutcomeFixture(workerOutcomePins) {
  function workerOutcomeOverlay(text, name = "proxy-response.ts") {
    assert.equal(createHash("sha256").update(text).digest("hex"), workerOutcomePins[name]);
    const edit = (before, after, count = 1) => { assert.equal(text.split(before).length, count + 1, before); text = text.replaceAll(before, after); };
    if (name === "proxy.ts") {
      // Thread the already-held operation to the original source owner; the
      // forwarded/normalized reader is deliberately NOT used as its identity.
      edit('function ownOrdinaryResponse(response: Response, completion: ProxyCompletion): Response {',
        'function ownOrdinaryResponse(response: Response, completion: ProxyCompletion, operation: HttpOperation): Response {');
      edit('ownOrdinaryResponse(response, completion)', 'ownOrdinaryResponse(response, completion, operation)', 2);
      edit('    const reader = response.body!.getReader(), input = inputRetirement(reader);',
        '    const reader = response.body!.getReader(), input = inputRetirement(reader);\n    qianfanOutcome.current.bind(operation, response, reader);');
      edit('              const next = await input.read(() => reader.read());',
        '              qianfanOutcome.current.readStart(operation, reader);\n              const next = await input.read(() => reader.read());\n              qianfanOutcome.current.readDone(operation, reader);');
      edit('            } catch (error) {\n              if (!stopped)',
        '            } catch (error) {\n              qianfanOutcome.current.failure(operation, reader, error);\n              if (!stopped)');
    } else {
      assert.equal(name, "proxy-response.ts");
      // Embeddings bypass the ordinary Chat completion wrapper. Their original
      // fetched reader belongs directly to observeUsage, not to a forwarded body.
      edit('  const reader = response.body.getReader(), sourceRetired = replayRetirements.get(response.body);',
        '  const reader = response.body.getReader(), sourceRetired = replayRetirements.get(response.body);\n  if (responseFormat === "openai.embeddings") qianfanOutcome.current.bind(operation, response, reader);');
      edit('        const next = await input.read(() => reader.read());',
        '        if (responseFormat === "openai.embeddings") qianfanOutcome.current.readStart(operation, reader);\n        const next = await input.read(() => reader.read());\n        if (responseFormat === "openai.embeddings") qianfanOutcome.current.readDone(operation, reader);');
      edit('      } catch (error) { if (!finished) { finish("failed", error); controller.error(error); } }',
        '      } catch (error) { if (responseFormat === "openai.embeddings") qianfanOutcome.current.failure(operation, reader, error); if (!finished) { finish("failed", error); controller.error(error); } }');
      edit('    resolve({ ...inspection, delivery,', '    qianfanOutcome.current.inspection(operation, inspection, delivery);\n    resolve({ ...inspection, delivery,');
      edit('    cancel(reason) { return finish("canceled", reason); },',
        '    cancel(reason) { const prior = qianfanOutcome.current.downstreamStart(operation, reason); try { return finish("canceled", reason); } finally { qianfanOutcome.current.downstreamEnd(operation, prior); } },');
    }
    return 'import { qianfanOutcome } from "qianfan-outcome-witness";\n' + text;
  }

  async function bundleWorkerOutcome(contents) {
    const require = createRequire(import.meta.resolve("wrangler/package.json")), { build } = require("esbuild");
    const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: "qianfan-fixture.ts", loader: "ts" },
      write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
      plugins: [{ name: "qianfan-first-outcome", setup(build) {
        build.onResolve({ filter: /^qianfan-outcome-witness$/ }, () => ({ path: "witness", namespace: "qianfan" }));
        build.onLoad({ filter: /.*/, namespace: "qianfan" }, () => ({ contents: "export const qianfanOutcome = { current: undefined };", loader: "js" }));
        build.onLoad({ filter: /[/\\]worker[/\\](?:proxy|proxy-response|http-operation)\.ts$/ }, args => {
          const name = args.path.split(/[/\\]/).at(-1), source = readFileSync(args.path, "utf8");
          assert.equal(createHash("sha256").update(source).digest("hex"), workerOutcomePins[name]);
          return { contents: name !== "http-operation.ts" ? workerOutcomeOverlay(source, name) : source, loader: "ts" };
        });
      } }],
    });
    return bundle.outputFiles[0].text;
  }

  return { workerOutcomeOverlay, bundleWorkerOutcome };
}
