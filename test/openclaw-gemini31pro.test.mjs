import { registerGoogleTextContract } from "./helpers/openclaw-google-text.mjs";
registerGoogleTextContract({ modelId: "gemini-3.1-pro-preview", expectedMicros: 4000, basis: "manifest_rate_upper_bound" });
