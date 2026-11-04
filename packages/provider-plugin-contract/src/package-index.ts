/** A build artifact for packaging tools. No resource is authorized for HTML rendering. */
export interface ProviderPackageResource {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ProviderPackageIndex {
  schema: "clawrouter.provider-package-index.v1";
  packages: {
    id: string;
    version: string;
    displayName: string;
    digest: string;
    manifest: ProviderPackageResource;
    documentation: ProviderPackageResource;
    license: ProviderPackageResource;
    logo?: { light: ProviderPackageResource; dark?: ProviderPackageResource };
    fixtures: ProviderPackageResource[];
  }[];
}
