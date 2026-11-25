import { NATIVE_CLASSES } from '../../scripts/deploy-train-runtime.mjs';
import { uploadMessage } from '../../scripts/deploy-train-secrets.mjs';

export const runtimeSha = 'e'.repeat(64);
export const native = { schema: 1, runtimeSha };
export function nativeVersion(id, sha, blue = '99999999-9999-9999-9999-999999999999') {
  const vars = { LARGE_HTTP_ORIGIN: 'https://clawrouter.openclaw.ai', LARGE_HTTP_ENABLED: '1', LARGE_HTTP_INGRESS_ENABLED: '1', LARGE_HTTP_CAPACITY: '8', LARGE_HTTP_TENANT_LIMIT: '2', LARGE_HTTP_SLOT_STARTS_PER_HOUR: '24' };
  return { id, annotations: { 'workers/tag': sha, 'workers/message': uploadMessage({ run: '123', blue, sha, native }) }, resources: { bindings: [
    ...Object.entries(NATIVE_CLASSES).map(([name, class_name]) => ({ type: 'durable_object_namespace', name, class_name, namespace_id: `fixture-${name}` })),
    ...Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
    { type: 'secret_text', name: 'LARGE_HTTP_TOKEN' }, { type: 'assets', name: 'ASSETS' },
    { type: 'kv_namespace', name: 'POLICY_KV', namespace_id: 'a'.repeat(32) },
    { type: 'r2_bucket', name: 'CONTENT_ARCHIVE', bucket_name: 'clawrouter-content' },
    { type: 'queue', name: 'USAGE_QUEUE', queue_name: 'clawrouter-usage' },
  ] } };
}
