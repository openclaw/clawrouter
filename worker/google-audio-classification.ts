import { googleField } from "./google-protocol.ts";

const nativeFormats = new Set(["google.music_generate", "google.speech_generate_content", "google.speech_interactions"]);
const audioModels = new Set([
  "lyria-3-clip-preview", "lyria-3-pro-preview",
  "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts",
  "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts",
]);

// Intent only: no route, model availability, tariff, duration or invoice is
// qualified here. Model identity comes from selection, never arbitrary JSON.
export function googleAudioRequest(selectedUpstreamModel: string | null | undefined, body: unknown, requestFormat: string): boolean {
  if (nativeFormats.has(requestFormat)) return true;
  if (requestFormat !== "google.generate_content") return false;
  if (selectedUpstreamModel != null && audioModels.has(selectedUpstreamModel)) return true;
  const config = googleField(body, "generationConfig", "generation_config");
  const modalities = googleField(config, "responseModalities", "response_modalities");
  // Google's published GenerationConfig.Modality.AUDIO is 3. Recognizing a
  // quoted integer conservatively also prevents it from acquiring text pricing.
  return Array.isArray(modalities) && modalities.some(value => value === "AUDIO" || value === 3 || value === "3");
}
