import { useEffect, useState } from "react";
import { useBridge } from "../lib/computer-bridge";

// Per Project root: the mentioned paths found in it, and every path already looked up.
const cache = new Map<string, { known: Set<string>; asked: Set<string> }>();

function entry(root: string) {
  let found = cache.get(root);
  if (!found) cache.set(root, (found = { known: new Set(), asked: new Set() }));
  return found;
}

/** A path picked from the Project's file list is known without another search. */
function markFileKnown(root: string, path: string) {
  const found = entry(root);
  found.known.add(path);
  found.asked.add(path);
}

/** How long a lookup that found nothing stands: a file created meanwhile becomes a chip after this. */
const MISS_TTL_MS = 30_000;

const TRAILING_PUNCTUATION = /[.,!?;:)\]}]+$/;

/** The paths a draft's `@` mentions could name: quoted ones as written, bare ones also without trailing punctuation. */
function mentionCandidates(draft: string): string[] {
  const paths = new Set<string>();
  for (const match of draft.matchAll(/(^|\s)@(?:"([^"\n]+)"|([^\s"]\S*))/g)) {
    if (match[2] !== undefined) paths.add(match[2]);
    else if (match[3] !== undefined) {
      if (/^chat:[1-9]\d*[.,!?;:)\]}]*$/.test(match[3])) continue;
      paths.add(match[3]);
      const trimmed = match[3].replace(TRAILING_PUNCTUATION, "");
      if (trimmed) paths.add(trimmed);
    }
  }
  return [...paths];
}

/**
 * Which of the draft's `@` mentions name a file in the Project, so they show as chips (spec "Chips": the text is the
 * source of truth, so chips survive restarts and drafts from the phone). Each path is searched once per root, 100 ms
 * after it appears; `skip` is the mention being typed, which the @ menu is already searching (its results go to
 * `markKnown`).
 */
export function useKnownFiles(
  root: string,
  draft: string,
  skip: string | null,
): { known: ReadonlySet<string>; version: number; markKnown: (path: string) => void } {
  const bridge = useBridge();
  const [version, setVersion] = useState(0);
  const found = entry(root);
  const missing = mentionCandidates(draft)
    .filter((path) => path !== skip && !found.asked.has(path))
    .join("\n");
  useEffect(() => {
    if (!missing || typeof bridge.searchProjectFiles !== "function") return;
    const timer = setTimeout(() => {
      const current = entry(root);
      for (const path of missing.split("\n")) {
        if (current.asked.has(path)) continue;
        current.asked.add(path);
        bridge.searchProjectFiles(root, path).then(
          (files) => {
            if (!files.includes(path)) {
              // Asked again after the TTL, when the next render sees the mention unasked.
              setTimeout(() => {
                current.asked.delete(path);
                setVersion((count) => count + 1);
              }, MISS_TTL_MS);
              return false;
            }
            current.known.add(path);
            setVersion((count) => count + 1);
            return true;
          },
          // Looked up again the next time the draft changes.
          () => current.asked.delete(path),
        );
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [bridge, root, missing]);
  const markKnown = (path: string) => {
    if (found.known.has(path)) return;
    markFileKnown(root, path);
    setVersion((count) => count + 1);
  };
  return { known: found.known, version, markKnown };
}
