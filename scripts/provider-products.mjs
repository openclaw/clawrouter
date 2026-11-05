/** Compile schema-validated product metadata without changing legacy execution rules. */
export function compileProviderProducts(manifest) {
  if (manifest.products === undefined) return undefined;
  const ids = new Set();
  const fail = (id, reason) => { throw new Error(`provider ${manifest.id} product ${id}: ${reason}`); };
  return manifest.products.map(product => {
    if (ids.has(product.id)) fail(product.id, "duplicate product id");
    ids.add(product.id);
    let transport;
    if (product.binding.type === "grant-transport") {
      const transports = manifest.auth.grantTransports ?? {};
      if (!Object.hasOwn(transports, product.binding.grantKind)) fail(product.id, "unknown grant transport");
      transport = transports[product.binding.grantKind];
    }
    for (const endpoint of product.endpoints) {
      if (!Object.hasOwn(manifest.endpoints, endpoint)) fail(product.id, `unknown endpoint ${endpoint}`);
      if (transport?.allowedEndpoints && !transport.allowedEndpoints.includes(endpoint)) {
        fail(product.id, `endpoint ${endpoint} is excluded by grant transport`);
      }
    }
    return {
      id: product.id,
      displayName: product.displayName,
      commercialModel: product.commercialModel,
      authenticationMethod: product.authenticationMethod,
      binding: { ...product.binding },
      endpoints: [...product.endpoints].sort(),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
