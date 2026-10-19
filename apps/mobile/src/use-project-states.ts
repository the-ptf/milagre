import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "expo-router";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import type { AgentSession } from "@milagre/shared/model";
import { useSession } from "./session";

/** Project states by path, as `unreadRunRoutines`, `unreadRunChats` and `chatLeft` read them. */
type ProjectStates = Record<string, { sessions: Record<string, AgentSession> }>;

/**
 * The Project states this phone holds, for the Routines screens: the open Project's live copy, else the last copy of each
 * Project on the recent list or in `read`. The `read` Projects are read again from the Mac when the screen gains focus
 * (back from a Run Chat, which is read now) and whenever `version` changes (a new Run), but only those on the recent list:
 * reading a Project opens it on the Mac, which would put one removed from that list back on it.
 */
export function useProjectStates(read: readonly string[], version = ""): ProjectStates {
  const { client, recent, snapshot, cachedProject, previewProject } = useSession();
  const [revision, setRevision] = useState(0);
  const listed = new Set(recent.filter((item) => !isLinkScopeKey(item.path)).map((item) => item.path));
  const wanted = [...new Set(read)].filter((path) => listed.has(path)).join("\n");
  const known = [...new Set([...recent.map((item) => item.path), ...read])].join("\n");
  useFocusEffect(
    useCallback(() => {
      if (!client || !wanted) return;
      let live = true;
      void (async () => {
        // A Project that can't be read keeps its last copy.
        await Promise.all(wanted.split("\n").map((path) => previewProject(path).catch(() => null)));
        if (live) setRevision((value) => value + 1);
      })();
      return () => {
        live = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- a new version asks for a fresh read of the same Projects.
    }, [client, wanted, previewProject, version]),
  );
  return useMemo(() => {
    const states: ProjectStates = {};
    for (const path of known ? known.split("\n") : []) {
      const copy = path === snapshot?.project.path ? snapshot : cachedProject(path);
      if (copy) states[path] = copy.project.state;
    }
    return states;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision changes when a read Project's copy does.
  }, [known, snapshot, cachedProject, revision]);
}
