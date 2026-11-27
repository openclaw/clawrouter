/** Resolve explicit selections only. These definitions never establish runtime eligibility. */
export function compileProviderOffers(manifest, products) {
  if (!products?.some(product => product.offers !== undefined)) return undefined;
  const definitions = [];
  const models = new Map((manifest.models?.entries ?? []).map(model => [model.id, model]));
  for (const product of products) {
    const bindings = new Set();
    const fail = reason => { throw new Error(`provider ${manifest.id} product ${product.id} offer: ${reason}`); };
    for (const offer of product.offers ?? []) {
      if (!product.endpoints.includes(offer.endpoint)) fail(`endpoint ${offer.endpoint} is not in the product`);
      if (!manifest.capabilities.some(capability => capability.id === offer.capability && capability.endpoint === offer.endpoint)) {
        fail(`capability ${offer.capability} is not bound to endpoint ${offer.endpoint}`);
      }
      const binding = JSON.stringify([offer.endpoint, offer.capability]);
      if (bindings.has(binding)) fail(`duplicate binding ${binding}`);
      bindings.add(binding);
      const selected = offer.models === null ? [null] : offer.models.map(id => {
        const model = models.get(id);
        if (!model) fail(`unknown model ${id}`);
        if (!model.capabilities?.includes(offer.capability)) fail(`model ${id} does not declare ${offer.capability}`);
        return { id: model.id, upstream: model.upstream };
      });
      for (const model of selected) {
        definitions.push({
          id: `clawrouter.offer.v1:${JSON.stringify([manifest.id, product.id, offer.endpoint, offer.capability, model?.id ?? null])}`,
          providerId: manifest.id,
          productId: product.id,
          endpoint: offer.endpoint,
          capability: offer.capability,
          model,
          qualification: "declared",
        });
      }
    }
  }
  return definitions.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
