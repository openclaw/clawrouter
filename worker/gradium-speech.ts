// This slice matches the frozen client's unary formats. Other native output
// modes require their own consumer and response contract.
const outputFormats = new Set(["wav", "opus", "ulaw_8000"]);

export function validateGradiumSpeech(body: Record<string, unknown>): void {
  if (body.only_audio !== true) throw new Error("Gradium unary speech requires only_audio:true");
  if (typeof body.text !== "string" || !body.text.trim()) throw new Error("Gradium speech requires nonempty text");
  if (typeof body.voice_id !== "string" || !body.voice_id.trim()) throw new Error("Gradium speech requires a voice_id");
  if (typeof body.output_format !== "string" || !outputFormats.has(body.output_format)) throw new Error("Gradium unary speech supports wav, opus and ulaw_8000");
  if (body.stream !== undefined && body.stream !== false) throw new Error("Gradium unary speech does not support stream");
  if (body.json_config !== undefined) {
    if (typeof body.json_config !== "string") throw new Error("Gradium json_config must be an encoded JSON object");
    let config: unknown;
    try { config = JSON.parse(body.json_config); }
    catch { throw new Error("Gradium json_config must be an encoded JSON object"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Gradium json_config must be an encoded JSON object");
  }
}
