import type { Artifact, DesignArtifact } from "@milagre/shared/artifact";
import type { Client } from "./client";

type Source = Pick<Client, "url" | "call">;
type Request = { chatId: string; id: string; version?: number };
const unsupported = new WeakSet<Source>();
let active: { url: string; fonts: Map<string, string> } | undefined;

/** Across sheet opens, but never across Computers. Late replies keep their original cache. */
export function designFontCache(url: string): Map<string, string> {
  if (active?.url !== url) active = { url, fonts: new Map() };
  return active.fonts;
}

/** Keep the CSS on the returned object by reference too: an active sheet must survive cache eviction. */
export async function loadCanvasDesign(source: Source, request: Request, fonts: Map<string, string>): Promise<Artifact> {
  if (unsupported.has(source)) return source.call<Artifact>("artifact:get", [request]);
  let artifact: Artifact;
  try {
    artifact = await source.call<Artifact>("artifact:get", [{ ...request, fonts: { have: [...fonts.keys()] } }]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Invalid arguments:") || !/\bfonts\b/.test(error.message)) throw error;
    const full = await source.call<Artifact>("artifact:get", [request]);
    unsupported.add(source);
    return full;
  }
  if (artifact.format !== "design" || !artifact.fontKey) return artifact;
  const css = artifact.fontCss || fonts.get(artifact.fontKey);
  // Pin the fallback to the version whose fonts were missing, even if a new version arrived meanwhile.
  if (!css) return source.call<Artifact>("artifact:get", [{ ...request, version: artifact.version }]);
  fonts.delete(artifact.fontKey);
  fonts.set(artifact.fontKey, css);
  // Bound the cross-sheet cache. Active documents retain the same string, without copying it.
  while (fonts.size > 8) fonts.delete(fonts.keys().next().value!);
  return { ...artifact, fontCss: css } satisfies DesignArtifact;
}
