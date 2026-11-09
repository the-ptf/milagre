import source from "pele/global";

/**
 * Pele's browser build (pele.run), as text: an Artifact page with Mermaid blocks carries it, and they draw in place.
 * Metro hands the file over as its text (scripts/text-module-transformer.cjs).
 */
export const PELE_SCRIPT: string = typeof source === "string" ? source : "";
