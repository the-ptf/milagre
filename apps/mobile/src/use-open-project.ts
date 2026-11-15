import { useCallback, useEffect, useRef, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import { useSession } from "./session";

/**
 * A screen reached for a Project other than the loaded one opens it itself, so the screen shows the splash mark
 * while it loads instead of the navigation showing a spinner. It loads on focus and on Retry only: while the screen
 * is showing, another Project can take over just before a navigation leaves it, and reopening this one would undo that.
 */
/** A missing folder reads as one, not as the Mac's ENOENT. */
function openFailure(message: string) {
  return /ENOENT|no such file or directory/i.test(message) ? "Couldn't find that folder on your computer. Check the path and try again." : message;
}

export function useOpenProject(params: { projectPath?: string; hostId?: string; id?: string }) {
  const session = useSession();
  const client = session.client;
  const wanted =
    params.projectPath && params.projectPath !== session.snapshot?.project.path && (!params.hostId || params.hostId === client?.url)
      ? params.projectPath
      : null;
  const wantedNow = useRef(wanted);
  useEffect(() => {
    wantedNow.current = wanted;
  }, [wanted]);
  const [failure, setFailure] = useState<{ path: string; error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { open } = session;
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const chatId = params.id;
  useFocusEffect(
    useCallback(() => {
      const target = wantedNow.current;
      if (!target || !client) return;
      let live = true;
      void openRef
        .current(target, { chatId: chatId ? Number(chatId) : undefined })
        .then((copy) => {
          if (live && copy && copy.project.path !== target) router.setParams({ projectPath: copy.project.path });
        })
        .catch((e) => {
          if (live) setFailure({ path: target, error: openFailure((e as Error).message) });
        });
      return () => {
        live = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `attempt` reloads after Retry
    }, [client, chatId, attempt]),
  );
  const retry = useCallback(() => {
    setFailure(null);
    setAttempt((value) => value + 1);
  }, []);
  return { wanted, error: wanted && failure?.path === wanted ? failure.error : "", retry };
}
