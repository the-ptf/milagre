import { useEffect, useState } from "react";
import { bridgeForKey } from "../lib/computer-bridge";

const TTL_MS = 30_000;
// Each scope's catalog read, and the last one it answered: a Chat opened again shows its chips from that at once while an
// older catalog is read again in the background.
const cache = new Map<string, { at: number; names: Promise<ReadonlyMap<string, string>>; last?: ReadonlyMap<string, string> }>();
const NONE: ReadonlyMap<string, string> = new Map();

/** The catalog is read once per scope (Project or computer) and shared by every message, refreshed after a short while. */
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
          // A failed read keeps the last catalog it had.
          .catch(() => entry.last ?? NONE)
      : Promise.resolve(NONE);
  cache.set(scope, entry);
  return entry.names;
}

/** Skill name (lowercase) to description for a sent message's chips; empty until loaded, and never read without a scope. */
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
  // Until this scope's read answers, the catalog it had last.
  return loaded?.scope === scope ? loaded.names : (cache.get(scope)?.last ?? NONE);
}
