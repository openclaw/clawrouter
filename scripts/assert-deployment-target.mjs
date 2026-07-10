import {
  assertDeploymentMutation,
  deploymentTarget,
  verifyPolicyKvNamespaceTarget,
} from "./deployment-profile.mjs";

const target = deploymentTarget();
const deploy = process.argv.includes("--deploy");
if (deploy || process.argv.includes("--mutation")) assertDeploymentMutation(target);
const namespace = deploy
  ? await verifyPolicyKvNamespaceTarget(target)
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
  ].join(" "),
);
