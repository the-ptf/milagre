// Node only: the packaged Electron main process and the host read Pele's browser build from node_modules.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let script;

/** Pele's browser build (pele/global), for an Artifact page with Mermaid blocks to carry: artifactDocument's `diagrams`. */
export function diagramScript() {
  script ??= readFileSync(createRequire(import.meta.url).resolve("pele/global"), "utf8");
  return script;
}
