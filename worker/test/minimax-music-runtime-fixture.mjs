// Synthetic declaration only. Production declarations remain separately owned.
export const musicModels = ["minimax/music-2.6", "minimax/music-2.6-free"];
export const musicModel = musicModels[0];
export const musicBody = (stream = false, model = "music-2.6") => ({ model, prompt: "Synthetic instrumental style", lyrics_optimizer: true,
  stream, output_format: "hex", audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" } });
// Encoding fixture only; existing leaf tests own decoder-verified playable audio.
export const musicResult = (model = "music-2.6") => ({ model, base_resp: { status_code: 0 }, data: { status: 2, audio: "00ff80" },
  extra_info: { music_size: 3, music_sample_rate: 44100, bitrate: 256000 } });
export const musicSse = model => "data: " + JSON.stringify(musicResult(model)) + "\n\ndata: [DONE]\n\n";
export function configureMusic(provider) {
  const endpoint = provider.endpoints[0], model = provider.models[0];
  provider.id = "minimax"; provider.base_urls = { default: "https://api.minimax.io" };
  provider.auth = { ...provider.auth, schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} };
  provider.adapter = { ...provider.adapter, injectHeaders: {}, injectQuery: {}, removeHeaders: [] };
  provider.endpoints = [{ ...endpoint, id: "music", method: "POST", path: "/v1/music_generation", path_params: [], query: {}, headers: {},
    request_format: "minimax.music", response_format: "minimax.music", streaming: "sse", native_proxy: true, timeout_ms: 10000,
    upstreamPath: undefined, modelPassthrough: undefined, auth: undefined, websocket: undefined, lifecycle: undefined, responsesLifecycle: undefined }];
  provider.capabilities = [{ id: "music.generate", endpoint: "music", methods: ["POST"] }];
  // Inherited Chat pricing is deliberately present to test hard-dollar denial.
  provider.models = musicModels.map(id => ({ ...model, id, upstream: id.slice("minimax/".length), capabilities: ["music.generate"], endpointPricing: undefined, availability: undefined }));
}
