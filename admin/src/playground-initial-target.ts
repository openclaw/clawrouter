import { playgroundServicePreset, preferredPlaygroundEndpoint } from "./domain";
import { serviceModelFromForm, serviceModelOptions } from "./ui-helpers";
import type { CatalogModel } from "./domain";
import type { PlaygroundForm, ProviderAccess, ProviderReadiness, RouteCatalog } from "./ui-types";

export function initialPlaygroundTarget(models: CatalogModel[], routes: RouteCatalog["manifestProxy"],
  accessByProvider: Map<string, ProviderAccess>, readinessByProvider: Record<string, ProviderReadiness>): Partial<PlaygroundForm> | undefined {
  const usable = (id: string) => {
    const access = accessByProvider.get(id);
    return access?.allowed && access.readiness?.executable && readinessByProvider[id]?.executable;
  };
  const eligible = models.filter(model => usable(model.provider));
  const model = eligible.find(candidate => candidate.provider === "openai") ?? eligible[0];
  if (model) return { mode: "model", model: model.id, endpoint: model.capabilities.includes("llm.chat") ? "/v1/chat/completions" : preferredPlaygroundEndpoint(model) };

  const serviceRoutes = routes.filter(route => usable(route.provider) && route.methods.length && !route.streaming);
  for (const provider of new Set(serviceRoutes.map(route => route.provider))) {
    const candidates = serviceRoutes.filter(route => route.provider === provider);
    for (const target of serviceModelOptions(candidates)) {
      const preset = playgroundServicePreset(target.route, target.model);
      if (serviceModelFromForm(preset, target.route) === target.model) return { mode: "service", ...preset };
    }
    // A raw service request need not carry a model. Do not manufacture a model
    // field (or choose a model-specific route whose preset cannot express it).
    for (const route of candidates) {
      const preset = playgroundServicePreset(route);
      if (serviceModelFromForm(preset, route)) continue;
      // Tool operations can advertise IDs but have a model-free JSON template
      // (e.g. search). An empty editor does not express a model-specific request.
      if (!route.models?.length || preset.servicePayload !== "{}") return { mode: "service", ...preset };
    }
  }
}
