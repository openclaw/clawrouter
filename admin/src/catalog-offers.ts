import { assessModelRequest } from "../../shared/model-request-parameters";
import { playgroundPayload, playgroundServicePreset } from "./domain";
import type { PlaygroundMessage } from "./domain";
import type { CatalogOffer, ClientCatalog, ClientCatalogModel, PlaygroundForm, RouteCatalog } from "./ui-types";

export interface CatalogTarget {
  key: string;
  provider: string;
  providerName: string;
  observedAt: string;
  offer: CatalogOffer;
  model?: ClientCatalogModel;
  descriptor?: RouteCatalog["manifestProxy"][number];
  mode: PlaygroundForm["mode"];
  blocker: string | null;
}

export function catalogScopeKey(scope: ClientCatalog["scope"]) {
  return JSON.stringify([scope.authType, scope.credentialId, scope.principalId]);
}

export function offerKey(scope: ClientCatalog["scope"], provider: string, offer: CatalogOffer) {
  return JSON.stringify([catalogScopeKey(scope), provider, offer.endpoint, offer.modelId, offer.transport, offer.routeKind, offer.route, offer.policyId, offer.policyGeneration]);
}

export function browserCatalog(catalog: ClientCatalog | null | undefined, principalId: string | null | undefined): ClientCatalog | null {
  return catalog?.version === "clawrouter.client-catalog.v1" && typeof catalog.observedAt === "string" && catalog.scope?.authType === "access"
    && catalog.scope.credentialId === null && !!principalId && catalog.scope.principalId === principalId && Array.isArray(catalog.providers)
    && catalog.providers.every((provider) => provider && typeof provider.id === "string" && typeof provider.displayName === "string"
      && provider.allowed === true && Array.isArray(provider.policies) && Array.isArray(provider.offers) && Array.isArray(provider.models)
      && provider.models.every((model) => model && typeof model.id === "string" && Array.isArray(model.capabilities))
      && provider.readiness && Array.isArray(provider.readiness.reasons) && Array.isArray(provider.readiness.missingConfig)) ? catalog : null;
}

export function catalogTargets(catalog: ClientCatalog | null, routes: RouteCatalog): CatalogTarget[] {
  return (catalog?.providers ?? []).flatMap((provider) => (provider.offers ?? []).flatMap((offer) => {
    if (!validBrowserOffer(offer)) return [];
    const descriptor = routes.manifestProxy.find((route) => route.provider === provider.id && route.endpoint === offer.endpoint);
    const model = provider.models.find((item) => item.id === offer.modelId);
    const mode = offer.modelId !== null && offer.routeKind === "unified"
      && ["/v1/playground/v1/chat/completions", "/v1/playground/v1/responses"].includes(offer.route) ? "model" : "service";
    const supported = mode === "model" || offer.routeKind === "playground" && !!descriptor
      || offer.routeKind === "unified" && offer.route === "/v1/playground/v1/embeddings";
    const blocker = !offer.eligible || offer.affordability === "exact-blocked" ? `Unavailable: ${offer.reasonCode ?? "operation blocked"}.`
      : !supported ? "Operation form unavailable. Refresh the catalog."
      : offer.modelId !== null && !model ? "Model metadata unavailable. Refresh the catalog." : null;
    return [{ key: offerKey(catalog!.scope, provider.id, offer), provider: provider.id, providerName: provider.displayName, observedAt: catalog!.observedAt, offer, model, descriptor, mode, blocker }];
  }));
}

function validBrowserOffer(offer: CatalogOffer) {
  return offer && offer.transport === "http" && (offer.routeKind === "unified" || offer.routeKind === "playground")
    && typeof offer.route === "string" && offer.route.startsWith("/v1/playground/")
    && typeof offer.endpoint === "string" && !!offer.endpoint && typeof offer.policyId === "string" && !!offer.policyId
    && typeof offer.policyGeneration === "string" && !!offer.policyGeneration
    && (offer.modelId === null || typeof offer.modelId === "string" && !!offer.modelId)
    && typeof offer.eligible === "boolean" && ["exact-covered", "exact-blocked", "request-dependent"].includes(offer.affordability);
}

export function resolveCatalogTarget(targets: CatalogTarget[], selected: CatalogTarget | null) {
  return selected ? targets.find((target) => target.key === selected.key) ?? null : null;
}

export function targetBlocker(targets: CatalogTarget[], selected: CatalogTarget | null) {
  const current = resolveCatalogTarget(targets, selected);
  return !selected ? "Choose a provider, operation and model or request."
    : current ? current.blocker : "Selected operation is no longer available. Refresh or choose another target.";
}

export function operationKey(target: CatalogTarget) {
  return JSON.stringify([target.offer.endpoint, target.offer.transport, target.offer.routeKind, target.offer.route]);
}

export function operationLabel(target: CatalogTarget) {
  return `${target.offer.endpoint.replaceAll("_", " ")}${target.offer.routeKind === "playground" ? " · JSON" : ""}`;
}

export function targetForm(form: PlaygroundForm, target: CatalogTarget): PlaygroundForm {
  const unified = target.offer.routeKind === "unified";
  const route = unified ? { provider: target.provider, endpoint: target.offer.endpoint, route: target.offer.route, methods: ["POST"], requestFormat: "openai.embeddings" } : target.descriptor;
  return { ...form, mode: target.mode, model: target.offer.modelId ?? "", endpoint: target.offer.route === "/v1/playground/v1/responses" ? "/v1/responses" : "/v1/chat/completions",
    ...(target.mode === "service" ? playgroundServicePreset(route, unified ? target.offer.modelId ?? "" : target.model?.upstream ?? target.offer.modelId ?? "") : {}) };
}

export function targetRequest(target: CatalogTarget, form: PlaygroundForm, conversation: PlaygroundMessage[] = []) {
  // Rebuild routing/model fields from the resolved offer. Editable request fields
  // never select a different route or silently inherit another model's facts.
  const canonical = { ...form, mode: target.mode, model: target.offer.modelId ?? "", endpoint: target.offer.route === "/v1/playground/v1/responses" ? "/v1/responses" as const : "/v1/chat/completions" as const };
  const unified = target.offer.routeKind === "unified";
  const payload = playgroundPayload(canonical, unified ? undefined : target.descriptor, conversation);
  const body = target.mode === "service" ? (payload as { body: unknown }).body : payload;
  if (target.mode === "service" && target.offer.modelId !== null) {
    const fields = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const pathModels = unified ? [] : Object.entries((payload as { pathParams: Record<string, string> }).pathParams).filter(([name]) => name === "model" || name === "deployment").map(([, value]) => value);
    // Unified dispatch resolves a qualified catalog ID. Scoped dispatch can use
    // upstream aliases, but every supplied body/path carrier must match the offer.
    const supplied = [...pathModels, ...(Object.hasOwn(fields, "model") || !pathModels.length ? [fields.model] : [])];
    if (supplied.some((value) => value !== target.offer.modelId && (unified || value !== target.model?.upstream))) throw new Error("Request model differs from the selected offer. Choose that model or a custom request first.");
  }
  const format = target.offer.routeKind === "unified" ? target.offer.route.endsWith("/responses") ? "openai.responses" : target.offer.route.endsWith("/embeddings") ? "openai.embeddings" : "openai.chat_completions" : target.descriptor?.requestFormat ?? "";
  const assessment = assessModelRequest(target.model ?? null, { id: target.offer.endpoint, request_format: format }, body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {});
  return { payload: target.mode === "service" && target.offer.routeKind === "unified" ? body : payload, assessment };
}
