import { useEffect, useState } from "react";
import { bridgeForKey } from "../lib/computer-bridge";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; names: Promise<ReadonlyMap<string, string>>; last?: ReadonlyMap<string, string> }>();
const NONE: ReadonlyMap<string, string> = new Map();

function catalogFor(scope: string) {
  const hit = cache.get(scope);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  const bridge = bridgeForKey(scope);
  const entry: { at: number; names: Promise<ReadonlyMap<string, string>>; last?: ReadonlyMap<string, string> } = {
    at: Date.now(),
    names: Promise.resolve(NONE),
    last: hit?.last,
  };
  entry.names =
    typeof bridge.listSkills === "function"
      ? bridge
          .listSkills(scope)
          .then((catalog) => {
            const names = new Map((catalog?.skills ?? []).map((skill) => [skill.name.toLowerCase(), skill.description] as const));
            entry.last = names;
            return names;
          })
          .catch(() => entry.last ?? NONE)
      : Promise.resolve(NONE);
  cache.set(scope, entry);
  return entry.names;
}

export function useSentSkills(scope: string | null, needed: boolean): ReadonlyMap<string, string> {
  const [loaded, setLoaded] = useState<{ scope: string; names: ReadonlyMap<string, string> } | null>(null);
  useEffect(() => {
    if (!needed || !scope) return;
    let live = true;
    void catalogFor(scope).then((names) => {
      if (live) setLoaded((current) => (current?.scope === scope && current.names === names ? current : { scope, names }));
      return names;
    });
    return () => {
      live = false;
    };
  }, [scope, needed]);
  if (!needed || !scope) return NONE;
  return loaded?.scope === scope ? loaded.names : (cache.get(scope)?.last ?? NONE);
}
