const baseUrl = required(process.env.CLAWROUTER_BASE_URL, "CLAWROUTER_BASE_URL").replace(/\/$/, "");
const smokeKey = process.env.CLAWROUTER_SMOKE_KEY;

await expectOk(`${baseUrl}/v1/health`, "health");
const providers = await expectOk(`${baseUrl}/v1/providers`, "providers");
if (!Array.isArray(providers.providers) || providers.providers.length < 20) {
  throw new Error("provider snapshot is unexpectedly small");
}

if (smokeKey) {
  const inspect = await fetch(`${baseUrl}/v1/key/inspect`, {
    headers: { authorization: `Bearer ${smokeKey}` },
  });
  if (!inspect.ok) {
    throw new Error(`/v1/key/inspect failed with ${inspect.status}`);
  }
}

if (process.env.CLAWROUTER_SMOKE_OPENAI === "1") {
  if (!smokeKey) {
    throw new Error("CLAWROUTER_SMOKE_KEY is required for OpenAI proxy smoke");
  }
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${smokeKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-5.5-mini",
      messages: [{ role: "user", content: "reply with ok" }],
      max_tokens: 8,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI proxy smoke failed with ${response.status}: ${await response.text()}`);
  }
}

console.log("deployed smoke passed");

async function expectOk(url, name) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${name} failed with ${response.status}`);
  }
  return response.json();
}

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
