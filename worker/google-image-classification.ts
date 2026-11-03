import { googleField } from "./google-protocol.ts";

// Classification is not route qualification or a tariff. The selected upstream
// model comes from routing, never an arbitrary JSON model/name or prompt field.
export function googleImageRequest(selectedUpstreamModel: string | null | undefined, body: unknown, requestFormat: string): boolean {
  if (requestFormat === "google.image_generate") return true;
  if (requestFormat !== "google.generate_content") return false;
  if (selectedUpstreamModel === "gemini-3.1-flash-image" || selectedUpstreamModel === "gemini-3-pro-image") return true;
  const config = googleField(body, "generationConfig", "generation_config");
  const modalities = googleField(config, "responseModalities", "response_modalities");
  // GenerationConfig.Modality.IMAGE = 2 in the published Google proto. ProtoJSON
  // permits integer enum values; quoted integers are conservatively recognized.
  return Array.isArray(modalities) && modalities.some(value => value === "IMAGE" || value === 2 || value === "2");
}
