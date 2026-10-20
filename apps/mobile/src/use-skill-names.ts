import { useEffect, useState } from "react";
import type { SkillCatalog } from "@milagre/shared/model";
import type { Client } from "./client";
import { useSession } from "./session";

const catalogs = new Map<string, Promise<string[]>>();

/** The skill names of a Project, for chips in sent messages. One request per Mac and Project, shared by every message. */
export function useSkillNames(projectPath: string | undefined) {
  const { client } = useSession();
  const [loaded, setLoaded] = useState<{ key: string; names: string[] } | null>(null);
  const key = client && projectPath ? `${client.url}|${projectPath}` : "";
  useEffect(() => {
    if (!key || !client) return;
    let cancelled = false;
    void skillNames(client, key, projectPath!).then((names) => !cancelled && setLoaded({ key, names }));
    return () => {
      cancelled = true;
    };
  }, [client, key, projectPath]);
  return loaded?.key === key ? loaded.names : EMPTY;
}
const EMPTY: string[] = [];

function skillNames(client: Client, key: string, projectPath: string) {
  let pending = catalogs.get(key);
  if (!pending) {
    pending = client
      .call<SkillCatalog>("skills:list", [projectPath])
      .then((catalog) => catalog.skills.map((skill) => skill.name))
      .catch(() => {
        catalogs.delete(key);
        return EMPTY;
      });
    catalogs.set(key, pending);
  }
  return pending;
}
