import { registerGoogleTextContract } from "./helpers/openclaw-google-text.mjs";
registerGoogleTextContract({ modelId: "gemini-3.6-flash", expectedMicros: 1575, basis: "manifest_rate_upper_bound" });
