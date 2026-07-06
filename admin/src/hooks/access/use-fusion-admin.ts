import { type FormEvent, useState } from "react";
import { errorMessage } from "../../domain";
import { defaultFusion, demo } from "../../ui-config";
import { request } from "../../ui-helpers";
import type { FusionConfig } from "../../ui-types";

interface Dependencies {
  allowDemo: boolean;
  gatewayOrigin: string;
  demoMode: boolean;
  setStatus: (status: string) => void;
  refresh: () => Promise<void>;
}

export function useFusionAdmin({ allowDemo, gatewayOrigin, demoMode, setStatus, refresh }: Dependencies) {
  const [config, setConfig] = useState<FusionConfig>(allowDemo ? demo.fusion : defaultFusion);
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      setError("");
      setStatus("saving fusion model");
      if (demoMode) setConfig({ ...config, adviserModels: cleanModels(config.adviserModels) });
      else {
        const saved = await request<FusionConfig>(gatewayOrigin, "/v1/admin/fusion", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...config, adviserModels: cleanModels(config.adviserModels) }),
        });
        setConfig(saved);
        await refresh();
      }
      setStatus("saved fusion model");
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(message);
    }
  }

  return {
    fusion: { config, setConfig, error, save },
    hydrate: (next: FusionConfig, background: boolean) => { if (!background) setConfig(next); },
  };
}

function cleanModels(models: string[]) {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean))).slice(0, 4);
}
