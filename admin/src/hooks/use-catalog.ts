import { useMemo, useState } from "react";
import { accessMap, readinessMap } from "../domain";
import { browserCatalog, catalogTargets, resolveCatalogTarget, type CatalogTarget } from "../catalog-offers";
import { demo, emptyRoutes } from "../ui-config";
import { catalogModels, matchesServiceQuery, providerBrandIcon, serviceItems } from "../ui-helpers";
import type { EntitlementsResponse, ProviderReadiness, ProviderRow, RouteCatalog, ServiceItem } from "../ui-types";

export function useCatalog(allowDemo: boolean, principalId?: string | null) {
  const [providers, setProviders] = useState<ProviderRow[]>(allowDemo ? demo.providers : []);
  const [routes, setRoutes] = useState<RouteCatalog>(allowDemo ? demo.routes : emptyRoutes);
  const [entitlements, setEntitlements] = useState<EntitlementsResponse | null>(allowDemo ? demo.entitlements : null);
  const [providerReadiness, setProviderReadiness] = useState<Record<string, ProviderReadiness>>(
    allowDemo ? readinessMap(demo.entitlements.providers.map((item) => item.readiness)) : {},
  );
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [inventoryMode, setInventoryMode] = useState(false);
  const [available, setAvailable] = useState(allowDemo);
  const accessByProvider = useMemo(() => accessMap(entitlements), [entitlements]);
  const currentCatalog = browserCatalog(entitlements?.catalog, principalId);
  const targets = useMemo(() => catalogTargets(available ? currentCatalog : null, routes), [available, currentCatalog, routes]);
  // Inventory belongs to configuration, policy previews and historical labels.
  // It cannot add executable choices to the signed-in catalog.
  const inventory = useMemo(() => serviceItems(providers, routes, providerReadiness, accessByProvider), [providers, routes, providerReadiness, accessByProvider]);
  const inventoryModels = useMemo(() => catalogModels(routes), [routes]);
  const services: ServiceItem[] = (currentCatalog?.providers ?? []).map((provider) => {
    const offers = targets.filter((target) => target.provider === provider.id);
    const modelIds = [...new Set(provider.offers.flatMap((offer) => offer.modelId ? [offer.modelId] : []))];
    const paths = [...new Set(provider.offers.map((offer) => offer.route))];
    return {
      id: provider.id, provider: provider.id, name: provider.displayName,
      kind: provider.readiness.serviceKind, category: provider.readiness.class,
      capabilities: [...new Set(provider.models.flatMap((model) => model.capabilities))],
      surfaces: [...new Set(provider.offers.map((offer) => offer.transport))], route: paths.join(", "), routeCount: paths.length,
      models: modelIds.length, modelIds, readiness: provider.readiness,
      access: { provider: provider.id, displayName: provider.displayName, serviceKind: provider.readiness.serviceKind, allowed: provider.allowed, policies: provider.policies, readiness: provider.readiness },
      offers: available ? offers : undefined, brandIcon: providerBrandIcon(provider.id),
    };
  });
  const displayedServices = inventoryMode ? inventory : services;
  const catalogNotice = !available || !currentCatalog ? "Catalog unavailable. Refresh to check current operation availability; previous service details may be out of date."
    : !services.length ? "No configured services are assigned to this identity. Ask an administrator to connect a provider and assign a policy."
    : !targets.some((target) => !target.blocker) ? "No browser operations are available. Inspect a service for its current reason." : "";
  const kinds = useMemo(() => ["all", ...Array.from(new Set(displayedServices.map((item) => item.kind))).sort()], [displayedServices]);
  const filteredServices = useMemo(
    () => displayedServices.filter((item) => (kind === "all" || item.kind === kind) && matchesServiceQuery(item, query)),
    [kind, query, displayedServices],
  );
  const selectedService = displayedServices.find((item) => item.id === selectedServiceId);

  function setEntitlementsWithReadiness(next: EntitlementsResponse | null) {
    setEntitlements(next);
    setAvailable(Boolean(browserCatalog(next?.catalog, principalId)));
    if (next) setProviderReadiness(readinessMap(next.providers.map((item) => item.readiness)));
  }

  return {
    providers,
    setProviders,
    routes,
    setRoutes,
    entitlements,
    setEntitlements: setEntitlementsWithReadiness,
    providerReadiness,
    setProviderReadiness,
    inventory, inventoryModels, inventoryMode, setInventoryMode, displayedServices, catalogNotice, targets,
    catalogAvailable: available && currentCatalog !== null,
    markUnavailable: () => setAvailable(false),
    resolveTarget: (selected: CatalogTarget | null) => resolveCatalogTarget(targets, selected),
    accessByProvider,
    services,
    query,
    setQuery,
    kind,
    setKind,
    kinds,
    filteredServices,
    selectedService,
    selectedServiceId,
    setSelectedServiceId,
  };
}
