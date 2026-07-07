# Amazon Bedrock

ClawRouter continues to run on Cloudflare Workers. The `aws-bedrock` provider
signs outbound requests from the Worker to the regional Amazon Bedrock Runtime
endpoint; it does not deploy ClawRouter on AWS.

## Supported surface

The provider exposes only the native Bedrock operations:

| ClawRouter endpoint | Amazon Bedrock operation |
| --- | --- |
| `POST /v1/proxy/aws-bedrock/invoke_model` | `InvokeModel` |
| `POST /v1/proxy/aws-bedrock/invoke_model_stream` | `InvokeModelWithResponseStream` |

Both routes use the normal ClawRouter proxy-key, policy, grant, budget,
retention, and audit controls. ClawRouter supplies AWS Signature Version 4 and
passes the Bedrock model ID, inference-profile ID, or supported resource ARN
plus request JSON to Bedrock.

This is a raw native integration. The caller must supply the JSON schema for
the selected model. ClawRouter does not call `Converse` or `ConverseStream`,
translate OpenAI or Anthropic messages, or normalize the model-specific JSON
response. See AWS's [model inference parameter reference][model-parameters],
[InvokeModel API][invoke-model], and
[InvokeModelWithResponseStream API][invoke-model-stream].

## AWS permissions

Create a dedicated AWS principal with only the models and operations that the
ClawRouter policies need. Buffered calls require `bedrock:InvokeModel` and
streaming calls require `bedrock:InvokeModelWithResponseStream`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0"
    }
  ]
}
```

Adjust the Region and resource ARN for the model, provisioned model, custom
model, or imported model in use. Cross-Region inference profiles additionally
require permission for the profile and its underlying foundation models in
every destination Region, with organization SCPs that permit each destination;
see AWS's [cross-Region inference prerequisites][cross-region-prerequisites].
AWS documents the supported resource types and condition keys in its [Bedrock
service authorization reference][bedrock-iam]. Apply normal AWS
[least-privilege and temporary-credential guidance][iam-best-practices].

## Region

`AWS_REGION` is one non-secret Worker configuration value shared by every
Bedrock credential and grant in the deployment. It controls both the Runtime
endpoint and the SigV4 credential scope. A per-grant Region is not supported.

For a local deploy, export the value before rendering Wrangler configuration:

```sh
export AWS_REGION=us-east-1
pnpm cf:config
```

The renderer writes `AWS_REGION` under `[vars]` in
`.wrangler.generated.toml`. `pnpm cf:secrets` deliberately excludes it from
`wrangler secret bulk`. For GitHub Actions, set the non-secret repository
variable `CLAWROUTER_PROVIDER_AWS_REGION`; the deploy workflow maps it to
`AWS_REGION` before rendering the Worker configuration.

Choose a Region that supports every model ID used by the deployment. Consult
AWS's [model and Region availability table][model-availability].

## Credentials

### Worker-global credentials

Configure a dedicated AWS access key as Worker secrets:

```sh
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID --config .wrangler.generated.toml
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY --config .wrangler.generated.toml
```

Temporary AWS credentials also require their session token:

```sh
pnpm exec wrangler secret put AWS_SESSION_TOKEN --config .wrangler.generated.toml
```

`AWS_SESSION_TOKEN` is optional only for credentials that AWS issued without
one. Temporary credentials expire and ClawRouter does not assume a role or
refresh STS credentials; rotate all three values before expiration. AWS
requires the session token on requests signed with temporary credentials; see
[Using temporary credentials with AWS resources][temporary-credentials].

The controlled provider-secret workflow accepts
`CLAWROUTER_PROVIDER_AWS_ACCESS_KEY_ID`,
`CLAWROUTER_PROVIDER_AWS_SECRET_ACCESS_KEY`, and optional
`CLAWROUTER_PROVIDER_AWS_SESSION_TOKEN` GitHub Actions secrets. Region remains
the repository variable described above.

### Policy- or tenant-scoped grant

Prefer a scoped upstream grant when different ClawRouter policies or tenants
must use different AWS principals. Build the credential bundle from values
already present in the operator environment, then send it through the helper's
environment input rather than argv:

```sh
(
  set -eu
  export AWS_BEDROCK_CREDENTIALS="$(
    node -e '
      const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey,
        AWS_SESSION_TOKEN: sessionToken } = process.env;
      if (!accessKeyId || !secretAccessKey) process.exit(1);
      process.stdout.write(JSON.stringify({
        accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}),
      }));
    '
  )"
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

  pnpm cf:oauth:put -- \
    --kid svc_bedrock \
    --token-ref aws-bedrock \
    --kind api_key \
    --provider aws-bedrock \
    --label "Bedrock production" \
    --credentials-json-env AWS_BEDROCK_CREDENTIALS
)
```

Use `--tenant <tenant-id>` instead of `--kid <policy-id>` for a tenant-scoped
grant. A selected scoped grant supplies `accessKeyId`, `secretAccessKey`, and
optional `sessionToken`; it does not inherit missing credential fields from the
Worker-global secrets. `AWS_REGION` remains global.

## Budget policy

The manifest cannot assign one price or token-accounting schema to arbitrary
Bedrock model IDs and model-specific responses. Every policy with
`monthlyBudgetMicros` that can call `aws-bedrock` must therefore set a fixed
`requestCostMicros`; do not rely on dynamic token settlement for this provider.
A monthly-budget policy without that override fails closed with
`pricing_required`. Unbudgeted policies can execute, but use fallback request
accounting rather than provider-native token or cost settlement.

```sh
printf '%s' "$CLAWROUTER_PROXY_SECRET" | pnpm cf:key:put -- \
  --kid svc_bedrock \
  --secret-stdin \
  --providers aws-bedrock \
  --monthly-budget-micros 100000000 \
  --request-cost-micros 1000
```

Choose the fixed charge conservatively for the permitted models and request
sizes. It is ClawRouter budget accounting, not an AWS bill estimate.

## Invoke a model

The manifest request envelope keeps routing values separate from the raw model
body. This example uses the native Amazon Nova request schema. Neither AWS
credentials nor the model body belong in the URL or command-line arguments:

```sh
(
  set -e
  umask 077
  auth_file="$(mktemp "${TMPDIR:-/tmp}/clawrouter-auth.XXXXXX")"
  trap 'rm -f "$auth_file"' EXIT
  printf 'authorization: Bearer %s\n' "$CLAWROUTER_KEY" >"$auth_file"
  unset CLAWROUTER_KEY

  curl --fail-with-body --silent --show-error \
    "$CLAWROUTER_BASE_URL/v1/proxy/aws-bedrock/invoke_model" \
    -H "@$auth_file" \
    -H 'content-type: application/json' \
    -H 'accept: application/json' \
    --data-binary @- <<'JSON'
{
  "pathParams": {"model": "amazon.nova-lite-v1:0"},
  "body": {
    "schemaVersion": "messages-v1",
    "messages": [
      {"role": "user", "content": [{"text": "Reply with exactly: ok"}]}
    ],
    "inferenceConfig": {"maxTokens": 16}
  }
}
JSON
)
```

Use the streaming endpoint only with a model that AWS reports as supporting
streaming. The response is the raw binary AWS event stream, so save it rather
than printing it to a terminal:

```sh
(
  set -e
  umask 077
  auth_file="$(mktemp "${TMPDIR:-/tmp}/clawrouter-auth.XXXXXX")"
  stream_file="$(mktemp "${TMPDIR:-/tmp}/clawrouter-bedrock.XXXXXX")"
  keep_stream=
  trap 'rm -f "$auth_file"; test -n "$keep_stream" || rm -f "$stream_file"' EXIT
  printf 'authorization: Bearer %s\n' "$CLAWROUTER_KEY" >"$auth_file"
  unset CLAWROUTER_KEY

  curl --fail-with-body --silent --show-error --no-buffer \
    "$CLAWROUTER_BASE_URL/v1/proxy/aws-bedrock/invoke_model_stream" \
    -H "@$auth_file" \
    -H 'content-type: application/json' \
    -H 'accept: application/vnd.amazon.eventstream' \
    -H 'x-amzn-bedrock-accept: application/json' \
    --output "$stream_file" \
    --data-binary @- <<'JSON'
{
  "pathParams": {"model": "amazon.nova-lite-v1:0"},
  "body": {
    "schemaVersion": "messages-v1",
    "messages": [
      {"role": "user", "content": [{"text": "Reply with exactly: ok"}]}
    ],
    "inferenceConfig": {"maxTokens": 16}
  }
}
JSON
  keep_stream=1
  printf 'AWS event stream saved to %s\n' "$stream_file"
)
```

Treat the output file as retained model content and remove it according to the
deployment's data-handling policy.

## Forwarded Bedrock headers

ClawRouter always sets the SigV4, host, payload-hash, date, security-token, and
JSON content-type headers itself. Callers cannot override those values.

The buffered route accepts these optional Bedrock headers:

- `accept`
- `x-amzn-bedrock-guardrailidentifier`
- `x-amzn-bedrock-guardrailtrace`
- `x-amzn-bedrock-guardrailversion`
- `x-amzn-bedrock-performanceconfig-latency`
- `x-amzn-bedrock-request-metadata`
- `x-amzn-bedrock-service-tier`
- `x-amzn-bedrock-trace`

The streaming route also accepts `x-amzn-bedrock-accept`. Other caller headers
are not forwarded. Use only combinations supported by the chosen model and
operation; for example, AWS requires a guardrail version with a guardrail
identifier.

## Live smoke test

The default smoke target is a small Amazon Nova request. Override both the
model and body together when the configured Region, permitted resources, or
chosen model uses a different native schema:

```sh
export CLAWROUTER_SMOKE_LIVE_PROVIDERS=aws-bedrock
export CLAWROUTER_SMOKE_MODEL_AWS_BEDROCK=bedrock/amazon.nova-lite-v1:0
export CLAWROUTER_SMOKE_BODY_AWS_BEDROCK='{"schemaVersion":"messages-v1","messages":[{"role":"user","content":[{"text":"Reply with exactly: ok"}]}],"inferenceConfig":{"maxTokens":16}}'
pnpm cf:smoke
```

`CLAWROUTER_SMOKE_MODEL_AWS_BEDROCK` accepts a raw Bedrock model ID or ARN, or a
`bedrock/` or `aws-bedrock/` ClawRouter model ID. The body variable must contain
a JSON object. The smoke uses `InvokeModel`, not the streaming operation. For
workflow deploys, set both overrides as GitHub Actions repository variables.

## Current limitations

- `InvokeModel` and `InvokeModelWithResponseStream` only; no `Converse`,
  `ConverseStream`, Bedrock Responses API, agents, batch jobs, or model listing.
- No OpenAI-compatible `/v1/chat/completions`, `/v1/responses`, or Anthropic
  `/v1/messages` normalization for Bedrock.
- Model-specific request and response JSON; callers own model compatibility and
  schema migrations.
- Raw AWS event-stream responses; ClawRouter does not decode chunks to SSE or
  normalized JSON.
- One global `AWS_REGION` per Worker deployment.
- Pre-provisioned credential material only. No role assumption, web-identity
  exchange, metadata credentials, or automatic STS refresh inside the Worker.
- Budgeted policies require fixed `requestCostMicros`; no provider-native token
  or cost settlement.

[bedrock-iam]: https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html
[cross-region-prerequisites]: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
[iam-best-practices]: https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html
[invoke-model]: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html
[invoke-model-stream]: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModelWithResponseStream.html
[model-availability]: https://docs.aws.amazon.com/bedrock/latest/userguide/models.html
[model-parameters]: https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters.html
[temporary-credentials]: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_use-resources.html
