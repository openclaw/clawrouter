export const azureSpeechSsmlLimit = 65_536;
const formats = new Set(["audio-24khz-48kbitrate-mono-mp3", "ogg-24khz-16bit-mono-opus", "raw-8khz-8bit-mono-mulaw"]);
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function azureSpeechRegionalOrigin(region: string): string {
  if (!/^[a-z][a-z0-9]{1,31}$/.test(region)) throw new Error("Azure Speech region must be a bounded public-cloud region name");
  return `https://${region}.tts.speech.microsoft.com`;
}

export interface AzureSpeechInput {
  body: string;
  language: string;
  voice: string;
  inputCodePoints: number;
  characterUpperBound: number;
  outputFormat: string;
}

// Recognize only the exact simple SSML grammar emitted by the frozen consumer.
// This is deliberately not a general XML parser or a custom-voice contract.
export function prepareAzureSpeechSsml(body: string, contentType: string, outputFormat: string): AzureSpeechInput {
  if (typeof body !== "string" || new TextEncoder().encode(body).length > azureSpeechSsmlLimit) throw new Error("Azure Speech SSML exceeds router byte limit");
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/ssml+xml") throw new Error("Azure Speech requires application/ssml+xml");
  if (!formats.has(outputFormat)) throw new Error("Azure Speech output format is outside the frozen unary slice");
  // Explicit ranges reject invalid XML controls and unpaired UTF-16 surrogates.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(body) || body.includes("]]>")) throw new Error("Azure Speech SSML contains invalid XML characters");
  const match = /^<speak version="1\.0" xmlns="http:\/\/www\.w3\.org\/2001\/10\/synthesis" xml:lang="([^"<]*)"><voice name="([^"<]*)">([^<]*)<\/voice><\/speak>$/.exec(body);
  if (!match) throw new Error("Azure Speech requires the frozen single-voice SSML grammar");
  const language = decode(match[1]), voice = decode(match[2]), text = decode(match[3]);
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language) || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(voice)) throw new Error("Azure Speech language or voice is invalid");
  if (!text.trim()) throw new Error("Azure Speech text must be nonempty");
  return {
    body, language, voice, inputCodePoints: [...text].length, outputFormat,
    // Two per encoded UTF-16 unit also bounds Han double weighting, surrogate
    // pairs and entity spellings. This conservative bound is not an actual bill.
    characterUpperBound: match[3].length * 2,
  };
}

function decode(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) throw new Error("Azure Speech SSML entity is outside the frozen grammar");
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name]);
}
