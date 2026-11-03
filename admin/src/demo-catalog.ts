import snapshot from "../../worker/generated/provider-snapshot.json" with { type: "json" };
import { createRouteCatalog, type CatalogProvider } from "../../shared/route-catalog.ts";
import type { ProviderRow, RouteCatalog } from "./ui-types";

const catalogSnapshot = snapshot as unknown as { providers: Array<CatalogProvider & { auth: NonNullable<ProviderRow["auth"]> }> };

export function demoCatalog(): { providers: ProviderRow[]; routes: RouteCatalog } {
  const providers: ProviderRow[] = catalogSnapshot.providers.map((provider) => ({
    id: provider.id,
    display_name: provider.display_name,
    class: provider.class,
    service_kind: provider.service_kind,
    meter: provider.meter,
    capabilities: provider.capabilities.map((capability) => ({ id: capability.id })),
    auth: {
      authorization: provider.auth.authorization ? { grantKind: provider.auth.authorization.grantKind } : null,
      grantTransports: provider.auth.grantTransports,
    },
    quota: provider.quota,
  }));
  return { providers, routes: createRouteCatalog(catalogSnapshot.providers) };
}
