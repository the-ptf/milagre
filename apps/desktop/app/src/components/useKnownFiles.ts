import { useEffect, useState } from "react";
import { useBridge } from "../lib/computer-bridge";

const cache = new Map<string, { known: Set<string>; asked: Set<string> }>();

function entry(root: string) {
  let found = cache.get(root);
  if (!found) cache.set(root, (found = { known: new Set(), asked: new Set() }));
  return found;
}

function markFileKnown(root: string, path: string) {
  const found = entry(root);
  found.known.add(path);
  found.asked.add(path);
}

const MISS_TTL_MS = 30_000;

const TRAILING_PUNCTUATION = /[.,!?;:)\]}]+$/;

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
