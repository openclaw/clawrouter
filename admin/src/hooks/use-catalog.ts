import { useMemo, useState } from "react";
import { accessMap, readinessMap, routeKey } from "../domain";
import { demo, emptyRoutes } from "../ui-config";
import { catalogModels, matchesServiceQuery, serviceItems } from "../ui-helpers";
import type { EntitlementsResponse, ProviderReadiness, ProviderRow, RouteCatalog } from "../ui-types";

export function useCatalog(allowDemo: boolean) {
  const [providers, setProviders] = useState<ProviderRow[]>(allowDemo ? demo.providers : []);
  const [routes, setRoutes] = useState<RouteCatalog>(allowDemo ? demo.routes : emptyRoutes);
  const [entitlements, setEntitlements] = useState<EntitlementsResponse | null>(allowDemo ? demo.entitlements : null);
  const [providerReadiness, setProviderReadiness] = useState<Record<string, ProviderReadiness>>(
    allowDemo ? readinessMap(demo.entitlements.providers.map((item) => item.readiness)) : {},
  );
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [selectedServiceId, setSelectedServiceId] = useState(demo.services[0]?.id ?? "");
  const accessByProvider = useMemo(() => accessMap(entitlements), [entitlements]);
  const services = useMemo(
    () => serviceItems(providers, routes, providerReadiness, accessByProvider),
    [accessByProvider, providerReadiness, providers, routes],
  );
  const models = useMemo(() => {
    const catalog = catalogModels(routes);
    const fusion = accessByProvider.get("clawrouter");
    return fusion?.allowed
      ? [{ id: "clawrouter/fusion", provider: "clawrouter", capabilities: ["llm.chat"] }, ...catalog]
      : catalog;
  }, [accessByProvider, routes]);
  const serviceRoutes = useMemo(() => routes.manifestProxy, [routes]);
  const kinds = useMemo(() => ["all", ...Array.from(new Set(services.map((item) => item.kind))).sort()], [services]);
  const filteredServices = useMemo(
    () => services.filter((item) => (kind === "all" || item.kind === kind) && matchesServiceQuery(item, query)),
    [kind, query, services],
  );
  const selectedService = services.find((item) => item.id === selectedServiceId) ?? services[0];

  function setEntitlementsWithReadiness(next: EntitlementsResponse | null) {
    setEntitlements(next);
    if (next) setProviderReadiness(readinessMap(next.providers.map((item) => item.readiness)));
  }

  function mergeReadiness(readiness: ProviderReadiness[]) {
    setProviderReadiness((current) => ({ ...current, ...readinessMap(readiness) }));
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
    mergeReadiness,
    accessByProvider,
    services,
    models,
    serviceRoutes,
    query,
    setQuery,
    kind,
    setKind,
    kinds,
    filteredServices,
    selectedService,
    selectedServiceId,
    setSelectedServiceId,
    modelFor: (id: string) => models.find((model) => model.id === id) ?? models[0],
    serviceRouteFor: (key: string) => serviceRoutes.find((route) => routeKey(route) === key) ?? serviceRoutes[0],
  };
}
