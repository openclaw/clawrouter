import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { falManagedAdapter } from "./managed-fal.ts";
import { googleOmniManagedAdapter } from "./managed-google-omni-wrapper.ts";
import { kieManagedAdapter } from "./managed-kie.ts";
import { openRouterVideoManagedAdapter } from "./managed-openrouter-video.ts";
import { replicateManagedAdapter } from "./managed-replicate.ts";
import { togetherManagedAdapter } from "./managed-together-wrapper.ts";
import { vydraManagedAdapter } from "./managed-vydra.ts";

const adapters: readonly ManagedLifecycleAdapter[] = [
  replicateManagedAdapter, falManagedAdapter, kieManagedAdapter, vydraManagedAdapter, togetherManagedAdapter, googleOmniManagedAdapter,
  openRouterVideoManagedAdapter,
];

// A lifecycle declaration alone never activates an unknown protocol or format.
export function managedLifecycleAdapter(protocol: string): ManagedLifecycleAdapter | undefined {
  return adapters.find(adapter => adapter.protocol === protocol);
}

export function managedCreateAdapter(protocol: string, requestFormat: string): ManagedLifecycleAdapter | undefined {
  const adapter = managedLifecycleAdapter(protocol);
  return adapter?.requestFormats.includes(requestFormat) ? adapter : undefined;
}
