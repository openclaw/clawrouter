import { copyFileSync } from "node:fs";

// Keep the repository manifest schema authoritative; package only its build copy.
copyFileSync(new URL("../../providers/_schema/service-provider.schema.json", import.meta.url),
  new URL("./dist/service-provider.schema.json", import.meta.url));
