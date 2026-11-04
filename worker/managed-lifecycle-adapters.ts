import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { falManagedAdapter } from "./managed-fal.ts";
import { googleOmniManagedAdapter } from "./managed-google-omni-wrapper.ts";
import { kieManagedAdapter } from "./managed-kie.ts";
import { openRouterVideoManagedAdapter } from "./managed-openrouter-video.ts";
import { createPixVerseManagedAdapter } from "./managed-pixverse.ts";
import { createRunwayManagedAdapter } from "./managed-runway.ts";
import { replicateManagedAdapter } from "./managed-replicate.ts";
import { togetherManagedAdapter } from "./managed-together-wrapper.ts";
import { wanManagedAdapter } from "./managed-wan.ts";
import { vydraManagedAdapter } from "./managed-vydra.ts";

// Route/control lookup only: without a receipt-bound image ID, prepare denies.
// The input controller supplies that ID to its separate per-job image factory.
const pixVerseImageControlAdapter = createPixVerseManagedAdapter("image");

const adapters: readonly ManagedLifecycleAdapter[] = [
  replicateManagedAdapter, falManagedAdapter, kieManagedAdapter, vydraManagedAdapter, togetherManagedAdapter, googleOmniManagedAdapter,
  openRouterVideoManagedAdapter, wanManagedAdapter, createPixVerseManagedAdapter("text"), createRunwayManagedAdapter("text"),
];

// A lifecycle declaration alone never activates an unknown protocol or format.
export function managedLifecycleAdapter(protocol: string): ManagedLifecycleAdapter | undefined {
  return adapters.find(adapter => adapter.protocol === protocol);
}

export function managedCreateAdapter(protocol: string, requestFormat: string): ManagedLifecycleAdapter | undefined {
  if (protocol === "pixverse.video" && requestFormat === "pixverse.image_video") return pixVerseImageControlAdapter;
  const adapter = managedLifecycleAdapter(protocol);
  return adapter?.requestFormats.includes(requestFormat) ? adapter : undefined;
}
