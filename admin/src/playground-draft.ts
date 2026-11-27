import { playgroundPayload } from "./domain";
import type { PlaygroundForm, PlaygroundTurn, RouteCatalog } from "./ui-types";

/** A model follow-up carries successful model exchanges; service requests stand alone. */
export function playgroundDraftPayload(form: PlaygroundForm, route: RouteCatalog["manifestProxy"][number] | undefined, turns: PlaygroundTurn[]) {
  const conversation = form.mode === "model"
    ? turns.filter((turn) => turn.mode === "model" && !turn.error).flatMap((turn) => [
      { role: "user" as const, content: turn.prompt },
      { role: "assistant" as const, content: turn.response },
    ])
    : [];
  return playgroundPayload(form, route, conversation);
}
