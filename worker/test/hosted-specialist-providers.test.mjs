import "./typescript-setup.mjs";
import { execFileSync } from "node:child_process";
import { testHostedProviderContracts } from "./hosted-provider-contract-fixture.mjs";

const contracts = [
  ["abliteration", "ABLITERATION_API_KEY", "https://api.abliteration.ai/v1/chat/completions", "abliterated-model-large-v2", "abliterated-model-large-v2"],
  ["meta", "MODEL_API_KEY", "https://api.meta.ai/v1/chat/completions", "muse-spark-1.3", "muse-spark-1.3"],
  ["synthetic", "SYNTHETIC_API_KEY", "https://api.synthetic.new/openai/v1/chat/completions", "syn:large:text", "syn:large:text"],
  ["particle", "PARTICLE_API_KEY", "https://api.particle.ai/v1/chat/completions", "particle-1", "particle-ai/particle-1"],
];
const { providers } = JSON.parse(execFileSync(process.execPath, [
  "scripts/compile-providers.mjs", ...contracts.map(([id]) => `providers/${id}.provider.yaml`),
], { encoding: "utf8" }));

testHostedProviderContracts(contracts, providers, { foreignBindings: {
  OPENAI_API_KEY: "fixture-other-provider", ABLIT_KEY: "fixture-unbound-name",
} });
