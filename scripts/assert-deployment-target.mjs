import {
  assertDeploymentMutation,
  deploymentTarget,
  verifyPolicyKvPreviewNamespaceTarget,
  verifyPolicyKvNamespaceTarget,
} from "./deployment-profile.mjs";

const target = deploymentTarget();
if (target.environment === "edge-proof") throw new Error("edge-proof: use scripts/edge-proof.mjs plan; generic target commands do not qualify proof resources");
const deploy = process.argv.includes("--deploy");
if (deploy || process.argv.includes("--mutation")) assertDeploymentMutation(target);
const namespace = deploy
  ? await verifyPolicyKvNamespaceTarget(target)
  : null;
const previewNamespace = deploy
  ? await verifyPolicyKvPreviewNamespaceTarget(target)
  : null;

console.log(
  [
    `environment=${target.environment}`,
    `worker=${target.workerName}`,
    `baseUrl=${target.baseUrl}`,
    `queue=${target.queueName}`,
    `dlq=${target.queueDlqName}`,
    `r2=${target.contentBucketName}`,
    `retentionDefault=${target.contentRetentionDefault}`,
    ...(namespace ? [`kvNamespace=${namespace.title}`] : []),
    ...(previewNamespace ? [`kvPreviewNamespace=${previewNamespace.title}`] : []),
  ].join(" "),
);
