import type { SageRequest } from "../provider-sage.ts";
import type { SystemOneRequest } from "../provider-systemone.ts";

// Public TypeSafe OpenAPI example: a 16px synthetic red image, no user content.
export const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHElEQVR4nGP4TyJgoKcGBgbsaFQDfTUQB4aDBgDAen2fpitsVAAAAABJRU5ErkJggg==";
export const uri = `data:image/png;base64,${png}`;
export const sageImage = { content: { kind: "image", media: uri, text: "synthetic screenshot" }, question: { id: "gate", kind: "yesno", instructions: "Is it red?" } } satisfies SageRequest;
export const liquidImage = { model: "d1.1", state: "synthetic screenshot", images: [uri], questions: { gate: { type: "noul", instructions: "Is it red?" } } } satisfies SystemOneRequest;
export const typeSafeImage = { model: "jev-latest", state: ["synthetic screenshot", "fixture-image-reference"], assets: { "fixture-image-reference": { type: "image", format: "png", data_base64: png } }, questions: { gate: { type: "noul", instructions: "Is it red?" } } } satisfies SystemOneRequest;
