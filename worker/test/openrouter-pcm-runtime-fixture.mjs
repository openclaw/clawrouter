import { configureSpeech } from "./openrouter-speech-runtime-fixture.mjs";
export const pcmModel = "google/gemini-3.1-flash-tts-preview";
export const pcmBody = () => ({ model: pcmModel, input: "Synthetic opaque audio.", voice: "Kore", response_format: "pcm" });
export function configurePcm(provider) {
  configureSpeech(provider);
  provider.models = provider.models.filter(model => model.upstream !== pcmModel);
  provider.models.push({ id: `openrouter/${pcmModel}`, upstream: pcmModel, capabilities: ["audio.speech"], pricing: null, pricing_ref: null });
}
