import "./typescript-setup.mjs";
import { execFileSync } from "node:child_process";
import { testHostedProviderContracts } from "./hosted-provider-contract-fixture.mjs";

const contracts = [
  ["qianfan", "QIANFAN_API_KEY", "https://qianfan.baidubce.com/v2/chat/completions", "ernie-4.5-0.3b"],
  ["stepfun", "STEPFUN_API_KEY", "https://api.stepfun.ai/v1/chat/completions", "step-3.7-flash"],
  ["tencent-tokenhub", "TOKENHUB_API_KEY", "https://tokenhub.tencentmaas.com/v1/chat/completions", "deepseek-v4-flash"],
  ["volcengine", "VOLCANO_ENGINE_API_KEY", "https://ark.cn-beijing.volces.com/api/v3/chat/completions", "doubao-seed-2-1-pro-260915"],
  ["byteplus", "BYTEPLUS_API_KEY", "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions", "dola-seed-2-1-turbo-260628"],
];
const { providers } = JSON.parse(execFileSync(process.execPath, [
  "scripts/compile-providers.mjs", ...contracts.map(([id]) => `providers/${id}.provider.yaml`),
], { encoding: "utf8" }));

testHostedProviderContracts(contracts, providers, { foreignBindings: {
  ARK_API_KEY: "fixture-unknown-region", TOKENPLAN_API_KEY: "fixture-token-plan", STEPFUN_PLAN_API_KEY: "fixture-step-plan",
} });
