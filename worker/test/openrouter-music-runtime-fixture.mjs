export const musicModels = ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"];
export const musicBody = (model = musicModels[0]) => ({ model, messages: [{ role: "user", content: "Synthetic instrumental." }],
  modalities: ["text", "audio"], audio: { format: "wav" }, stream: true });
export function configureMusic(provider) {
  const endpoint = structuredClone(provider.endpoints.find(value => value.id === "chat_completions"));
  Object.assign(endpoint, { id: "music_generate", modelPassthrough: undefined, timeout_ms: 10000 });
  provider.endpoints = provider.endpoints.filter(value => value.id !== endpoint.id); provider.endpoints.push(endpoint);
  provider.capabilities = provider.capabilities.filter(value => value.id !== "music.generate");
  provider.capabilities.push({ id: "music.generate", endpoint: endpoint.id, methods: ["POST"] });
  provider.models = provider.models.filter(value => !musicModels.includes(value.upstream));
  for (const upstream of musicModels) provider.models.push({ id: `openrouter/${upstream}`, upstream,
    capabilities: ["music.generate"], pricing: null, pricing_ref: null });
}

// Byte-identical to the decoder-verified 24 kHz mono silent WAV in the leaf test.
export function musicWave() {
  const bytes = new Uint8Array(236), view = new DataView(bytes.buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, 228, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, 192, true); return bytes;
}
export function musicWire(model = musicModels[0], audio = musicWave()) {
  let text = ""; for (const byte of audio) text += String.fromCharCode(byte);
  const encoded = btoa(text), data = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
  const frame = delta => ({ id: "gen-synthetic-music", model, choices: [{ index: 0, delta, finish_reason: null }] });
  return data(frame({ audio: { data: encoded.slice(0, 3), transcript: "Synthetic " } }))
    + data(frame({ audio: { data: encoded.slice(3), transcript: "instrumental." } }))
    + data({ id: "gen-synthetic-music", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    + data({ id: "gen-synthetic-music", model, choices: [], usage: { prompt_tokens: 99, completion_tokens: 999, cost: 12.34 } })
    + data("[DONE]");
}
