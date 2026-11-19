import type { ManagedFileAdapter, ManagedFileAction, ManagedFileDescriptor, ManagedFileState } from "./managed-lifecycle-types.ts";
import { openRouterVideoFiles } from "./managed-openrouter-video-files.ts";
import { exactMediaParams } from "./managed-media-json.ts";
import { googleOmniVideoModel } from "./managed-google-omni.ts";
import { googleOmniApiBase, googleOmniEnvelopeBytes, googleOmniFileName, googleOmniVideos,
  prepareGoogleOmniFileControl, readGoogleOmniFileState, readGoogleOmniFile } from "./provider-google-omni-files.ts";

function requireFile(value: unknown, field: string): asserts value {
  if (!value) throw new Error(`invalid_managed_omni_file_${field}`);
}
function fileId(value: unknown): string {
  requireFile(typeof value === "string", "id");
  return googleOmniFileName(`files/${value}`).slice(6);
}
function descriptor(file: ManagedFileDescriptor): void {
  fileId(file.id); requireFile(file.mimeType === "video/mp4", "mime");
}
function queryFor(action: ManagedFileAction, query: URLSearchParams): void {
  requireFile(action === "metadata" || action === "download", "action");
  requireFile(action === "metadata" ? query.size === 0 : query.size === 1 && query.get("alt") === "media", "query");
}
function relativePath(value: unknown): string {
  requireFile(typeof value === "string" && value.length <= 8192
    && /^\/(?!\/)[A-Za-z0-9_/:.-]+(?:\?[A-Za-z0-9_=&-]+)?$/.test(value)
    && !/(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(value), "public_path");
  return value;
}
function observedState(file: ManagedFileDescriptor, state: ManagedFileState | undefined) {
  requireFile(state?.id === file.id && state.status === "active"
    && state.body.name === `files/${file.id}` && state.body.state === "ACTIVE", "not_active");
  return { name: `files/${file.id}`, state: "ACTIVE" as const, ready: true, failed: false };
}

const omniFiles: ManagedFileAdapter = {
  protocol: "google.omni_video",
  describe(observation, selectedBaseUrl) {
    // Only the already qualified original successful interaction can bind files.
    if (observation.terminal !== "succeeded") return [];
    requireFile(!observation.observationUnavailable && observation.id === observation.body.id
      && observation.body.object === "interaction" && observation.body.model === googleOmniVideoModel
      && observation.body.status === "completed", "observation");
    const base = googleOmniApiBase(selectedBaseUrl), files = new Map<string, ManagedFileDescriptor>();
    for (const video of googleOmniVideos(observation.body, googleOmniEnvelopeBytes)) {
      if (video.kind === "inline") continue;
      const target = prepareGoogleOmniFileControl("metadata", video, base);
      const id = fileId(target.fileName.slice(6));
      files.set(id, { id, mimeType: video.mimeType });
    }
    return [...files.values()];
  },
  identify(action, pathParams, query) {
    exactMediaParams(pathParams, ["file_id"]); queryFor(action, query);
    return fileId(pathParams.file_id);
  },
  control(action, endpoint, file, selectedBaseUrl, state) {
    descriptor(file);
    const query = new URLSearchParams(endpoint.query);
    queryFor(action, query);
    requireFile(endpoint.method === "GET" && endpoint.path === "/v1beta/files/${file_id}"
      + (action === "download" ? ":download" : ""), "endpoint");
    const base = googleOmniApiBase(selectedBaseUrl);
    const target = prepareGoogleOmniFileControl(action, { kind: "file", resource: `files/${file.id}`, mimeType: file.mimeType },
      base, action === "download" ? observedState(file, state) : undefined);
    const url = new URL(target.url), selected = new URL(selectedBaseUrl);
    const prefix = selected.pathname.replace(/\/+$/, "");
    requireFile(url.origin === selected.origin && url.pathname.startsWith(prefix + "/"), "origin");
    return { path: url.pathname.slice(prefix.length), query: url.searchParams };
  },
  async readState(response, file) {
    descriptor(file);
    if (response.status !== 200 || response.headers.has("content-range")) {
      void response.body?.cancel().catch(() => undefined); throw new Error("invalid_managed_omni_file_response");
    }
    const observed = await readGoogleOmniFileState(response, `files/${file.id}`);
    // Keep only the validated native identity/state; never metadata-supplied URLs.
    return { id: file.id, status: observed.state === "ACTIVE" ? "active" : observed.state === "FAILED" ? "failed" : "processing",
      body: { name: observed.name, state: observed.state } };
  },
  async readFile(response, file, maxBytes) {
    descriptor(file);
    const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (response.headers.has("content-range") || mime !== undefined && ![file.mimeType, "application/octet-stream", "binary/octet-stream"].includes(mime)) {
      void response.body?.cancel().catch(() => undefined); throw new Error("invalid_managed_omni_file_content");
    }
    return readGoogleOmniFile(response, maxBytes);
  },
  rewrite(body, paths) {
    requireFile(paths.length <= 64, "paths");
    // Failed or pending interactions need not carry output steps. They cannot
    // acquire file authority; the runtime supplies descriptors only on success.
    if (body.status !== "completed") {
      requireFile(paths.length === 0, "nonterminal_paths");
      return { ...body };
    }
    const links = new Map<string, string>();
    for (const path of paths) {
      const id = fileId(path.id); requireFile(!links.has(id), "duplicate_path");
      relativePath(path.metadata); links.set(id, relativePath(path.download));
    }
    // Validate native content first. Only output video URIs are rewritten;
    // caller inputs, thoughts, and inline bytes retain their original meaning.
    const videos = googleOmniVideos(body, googleOmniEnvelopeBytes);
    let index = 0;
    return { ...body, steps: (body.steps as Record<string, unknown>[]).map(step => {
      if (step.type !== "model_output") return step;
      return { ...step, content: (step.content as Record<string, unknown>[]).map(content => {
        if (content.type !== "video") return content;
        const video = videos[index++];
        if (video.kind === "inline") return content;
        const resource = video.resource.startsWith("files/") ? video.resource
          : new URL(video.resource).pathname.split("/").slice(-2).join("/").replace(/:download$/, "");
        const id = fileId(googleOmniFileName(resource).slice(6)), uri = links.get(id);
        requireFile(uri, "unbound_output");
        return { ...content, uri };
      }) };
    }) };
  },
};

// Discovery is not activation. Runtime must attach the factory result through
// its published lifecycle.files field and qualify original-job endpoint links.
export function managedFileAdapter(protocol: string): ManagedFileAdapter | undefined {
  return protocol === omniFiles.protocol ? omniFiles : protocol === openRouterVideoFiles.protocol ? openRouterVideoFiles : undefined;
}

