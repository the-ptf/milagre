// Keep the exact production Artifact helper/CSP and diagram renderer in the Rust binary.
import { mkdirSync, writeFileSync } from "node:fs";
import { artifactDocument, artifactCsp, ARTIFACT_CSP } from "../../packages/shared/src/artifact-document.mjs";
import { diagramScript } from "../../packages/shared/src/diagram-script.mjs";
const destination = new URL("./generated/", import.meta.url);
mkdirSync(destination, { recursive: true });
const marker = "MILAGRE_CONTENT_BODY_MARKER";
const prefix = (options) => artifactDocument(marker, options).slice(0, -marker.length);
writeFileSync(
  new URL("content-support.json", destination),
  JSON.stringify({
    policy: artifactCsp("milagre-artifact:"),
    inlinePolicy: ARTIFACT_CSP,
    inline: prefix({}),
    page: prefix({ page: true, assets: "milagre-artifact:" }),
    diagrams: diagramScript(),
  }),
);
