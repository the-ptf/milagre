import { useEffect, useState } from "react";
import { bridgeForKey } from "../lib/computer-bridge";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; names: Promise<ReadonlyMap<string, string>> }>();
const NONE: ReadonlyMap<string, string> = new Map();

/** The catalog is read once per scope (Project or computer) and shared by every message, refreshed after a short while. */
function catalogFor(scope: string) {
  const hit = cache.get(scope);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  const bridge = bridgeForKey(scope);
  const names =
    typeof bridge.listSkills === "function"
      ? bridge
          .listSkills(scope)
          .then((catalog) => new Map((catalog?.skills ?? []).map((skill) => [skill.name.toLowerCase(), skill.description] as const)))
          .catch(() => NONE)
      : Promise.resolve(NONE);
  cache.set(scope, { at: Date.now(), names });
  return names;
}

/** Skill name (lowercase) to description for a sent message's chips; empty until loaded, and never read without a scope. */
export function useSentSkills(scope: string | null, needed: boolean): ReadonlyMap<string, string> {
  const [loaded, setLoaded] = useState<{ scope: string; names: ReadonlyMap<string, string> } | null>(null);
  useEffect(() => {
    if (!needed || !scope) return;
    let live = true;
    void catalogFor(scope).then((names) => {
      if (live) setLoaded({ scope, names });
      return names;
    });
    return () => {
      live = false;
    };
  }, [scope, needed]);
  return needed && scope && loaded?.scope === scope ? loaded.names : NONE;
}
