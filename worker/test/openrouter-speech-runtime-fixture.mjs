// Exact offline decoder-verified MP3 from the qualified native leaf test.
export const speechFixture = {"base64":"//PExABJDAo0AVx4ATRqNNGo80mmzUqvNbr01yqzRJJMGJA4FKD5vVPz+M+juz0eFOxzs4a2zVZ9MrjsxaITFwkMQB4w8IDEQkMRB4w0FjCQOMEAQtYBjAdwBOAAwAWARgqxMzLOgtgtgmgmg9BcFBEvDT5pmmh6vj0f7gMDI8pl+yRNXvvEB4r399+937OrGR5SlHjxkV7O/fv379+zqxkePHjx48ZFer379+/fv2dWKx48ePHjxkV7O/fv379+/VjI8ePHjx48Z379+/fv379kePHjx48ePGd+/fv379+/ePHjx48ePHj9+/fv379+/ePHjx48ePHj9+/fv379+/ePHjx48ePHj9+/fv379/HePHjx48ePIj9+/fv37+94kB48ePKUpe8N+/uHhgAAAAAqAADAYMBYUabTMHxGMSRaeJYUwcBIwvF8yPcI9yRQlSc+pHIw4ZY2if0z7JoxREYWChiBiwXBgyN5gC5lB5jCIYcZunQbbCSzhC1QFFpi//PExE5krDpgX53QAMstFCCD10K8M03Ea4qnzIJUxUhXCXcsNImmL8nnEMPoEUk3VsxNIGN31clrMSf52m8nn4eS0/BspZi4gEVmsfmLcABDKYy/s1Go1VbyXO48lM/DyG8nmXjGKUm4imZfGMQm0eymM1qamq0tLlTPxCKaHIRTQ5IDGojCDTPIzGnjCBzOHzGmDCAzNG6amxxx1llvHHVM/EIpn4hFM/EgrQ5IDMpDIBzUJTMnjJAzTITMmgElNIdMyWByU0RmmtY0uOsst48/L/+tDk5WhycrRSirRS9Wll6sY0QJETJCzGhBYiZISY0EPETIBTGgCYiZAGAjRWKMcBBRrX/v/y3+Osq28auWVbHGlll65LOXJZy5LOXJZ9yxu5YzuWCIoAjoONDxQDGQg0NFAUZDDQsUBxkONCRQIKiRoOKBhUaNBhQOIjxorFUwhDGRJAY0i6Y4mEGTBqjo7D78jaDTGsDeuDTjkbzFDwgiIRBlzxjA6CqXqAVB//PExC5O7Do0Cdp4ANYK9SCYssEhFxHpE1FxOFJCTAphcTRNEnJOUJXQ3g1ROVCnTRNFQrogwhRcWVhQ00VS3EqE2NFxgp1DUJXQkwOYlrjBTpoqFeEmCPFxmynTRUK8N4NUXGJthOVQrxbh6lDTcFWsrUW4epQ0jQVaytRbh6lDJGlVrK1FuHqUMkaVWsrUX4epQyPssLLIX4gyhkfZYWWQvxOlTCZrsLLIX4nSphM12FlkL8TpUtzNdhZZC/E6VLczXYWWQvxOlS3M13rLIX4nSpbldt69kOYnSpbldO9eyHMTplYldO9eyHMTplYldO9eyHMTplYldPBeyHMTplYldPBeyHMTplYlFPBeyHMTpxYlFGgvZDmJ0kxBTUU0LjCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq","bytes":1152,"sha256":"9048e9affe6127656a008c1d51225ef0283fc1ac439d59b1bc3a6f083c5e550c","decodedPcmBytes":3456};
export const speechModels = ["hexgrad/kokoro-82m", "elevenlabs/eleven-turbo-v2", "mistralai/voxtral-mini-tts-2603"];
export const speechBody = (model = speechModels[0]) => ({ model, input: "Synthetic speech.", voice: "synthetic_voice", response_format: "mp3" });
export function speechAudio() { return Uint8Array.from(atob(speechFixture.base64), character => character.charCodeAt(0)); }
export function configureSpeech(provider) {
  const endpoint = structuredClone(provider.endpoints.find(value => value.id === "chat_completions"));
  Object.assign(endpoint, { id: "speech", path: "/v1/audio/speech", method: "POST", methods: ["POST"],
    request_format: "openai.audio_speech", response_format: "audio.binary", streaming: null,
    path_params: [], path_param_styles: {}, query: {}, native_proxy: true, modelPassthrough: undefined, timeout_ms: 10000 });
  provider.endpoints = provider.endpoints.filter(value => value.id !== endpoint.id); provider.endpoints.push(endpoint);
  provider.capabilities = provider.capabilities.filter(value => value.id !== "audio.speech");
  provider.capabilities.push({ id: "audio.speech", endpoint: endpoint.id, methods: ["POST"] });
  provider.models = provider.models.filter(value => !speechModels.includes(value.upstream));
  for (const upstream of speechModels) provider.models.push({ id: `openrouter/${upstream}`, upstream, capabilities: ["audio.speech"], pricing: null, pricing_ref: null });
}
