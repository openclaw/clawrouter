import { useState } from "react";
import { operationKey, operationLabel, type CatalogTarget } from "./catalog-offers";

export function OfferPicker({ targets, selected, onSelect, provider }: {
  targets: CatalogTarget[];
  selected: CatalogTarget | null;
  onSelect: (target: CatalogTarget | null) => void;
  provider?: string;
}) {
  const [draftProvider, setDraftProvider] = useState("");
  const [draftOperation, setDraftOperation] = useState("");
  const activeProvider = provider ?? selected?.provider ?? draftProvider;
  const activeOperation = selected ? operationKey(selected) : draftOperation;
  const providers = [...new Map(targets.map((target) => [target.provider, target.providerName])).entries()];
  const providerTargets = targets.filter((target) => target.provider === activeProvider);
  const operations = [...new Map(providerTargets.map((target) => [operationKey(target), target])).entries()];
  const choices = providerTargets.filter((target) => operationKey(target) === activeOperation);
  const missing = selected && !choices.some((target) => target.key === selected.key);
  return <>
    {!provider ? <select className="providerPicker" aria-label="Provider" value={activeProvider} onChange={(event) => { setDraftProvider(event.target.value); setDraftOperation(""); onSelect(null); }}>
      <option value="" disabled>Choose provider</option>
      {activeProvider && !providers.some(([id]) => id === activeProvider) ? <option value={activeProvider} disabled>{selected?.providerName ?? activeProvider} · unavailable</option> : null}
      {providers.map(([id, name]) => <option key={id} value={id} disabled={!targets.some((target) => target.provider === id && !target.blocker)}>{name}{targets.some((target) => target.provider === id && !target.blocker) ? "" : " · unavailable"}</option>)}
    </select> : null}
    <select className="modelPicker" aria-label="Operation" value={activeOperation} disabled={!activeProvider || !operations.length} onChange={(event) => { setDraftProvider(activeProvider); setDraftOperation(event.target.value); onSelect(null); }}>
      <option value="" disabled>Choose operation</option>
      {selected && !operations.some(([id]) => id === activeOperation) ? <option value={activeOperation} disabled>{operationLabel(selected)} · unavailable</option> : null}
      {operations.map(([key, target]) => <option key={key} value={key} disabled={!providerTargets.some((item) => operationKey(item) === key && !item.blocker)}>{operationLabel(target)}</option>)}
    </select>
    <select className="modelPicker" aria-label="Model or request" value={selected?.key ?? ""} disabled={!activeOperation || !choices.length} onChange={(event) => onSelect(choices.find((target) => target.key === event.target.value) ?? null)}>
      <option value="" disabled>Choose model or request</option>
      {missing ? <option value={selected.key} disabled>{selected.offer.modelId ?? "Custom JSON request"} · unavailable</option> : null}
      {choices.map((target) => <option key={target.key} value={target.key} disabled={Boolean(target.blocker)}>{target.offer.modelId ?? "Custom JSON request"}{choices.filter((item) => item.offer.modelId === target.offer.modelId).length > 1 ? ` · ${target.offer.policyId}` : ""}{target.blocker ? " · unavailable" : ""}</option>)}
    </select>
  </>;
}
