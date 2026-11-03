const googleSpeechPreviewCutoff = Date.parse("2026-11-17T00:00:00Z");
const generateContentSpeechModels = new Set([
  "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts",
]);
const interactionsSpeechModels = new Set(["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]);

// Compiled protocol and selected upstream identity are authority; request
// contents, router aliases and a shared capability cannot select a transport.
export function nativeModelEligible(requestFormat: string | null | undefined, selectedUpstreamModel: string | null | undefined, now = Date.now()): boolean {
  if (requestFormat === "google.speech_generate_content") return Number.isFinite(now) && now < googleSpeechPreviewCutoff
    && typeof selectedUpstreamModel === "string" && generateContentSpeechModels.has(selectedUpstreamModel);
  if (requestFormat === "google.speech_interactions") return Number.isFinite(now)
    && typeof selectedUpstreamModel === "string" && interactionsSpeechModels.has(selectedUpstreamModel);
  return true;
}

// Isolate and colo catalog entries cannot carry preview eligibility across the
// qualification boundary even when their normal freshness lease is still live.
export function nativeModelEligibilityRevision(now = Date.now()): string {
  return Number.isFinite(now) && now < googleSpeechPreviewCutoff ? "speech-preview-active-v1" : "speech-preview-expired-v1";
}
