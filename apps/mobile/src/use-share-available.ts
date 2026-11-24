import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { onShareAvailability } from "./share-availability";

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };

/**
 * Whether the Artifact's Share entries show: the host says its sharing service is up for this Chat. Rechecked when the
 * app comes back, and told by an open Share sheet of the same Chat; an answer from another host or Chat never counts.
 */
export function useShareAvailable(source: Caller | null, hostId: string | undefined, chatId: string | undefined): boolean {
  const scope = useMemo(() => ({ source, chatId }), [source, chatId]);
  const [available, setAvailable] = useState<typeof scope | null>(null);
  const request = useRef(0);
  useEffect(() => {
    if (!source) return;
    let live = true;
    const refresh = () => {
      const current = ++request.current;
      setAvailable(null);
      source
        .call<{ available: boolean }>("artifact:sharing-status", [{ kind: "workspace", ...(chatId ? { chatId } : {}) }])
        .then((status) => {
          if (live && current === request.current && status?.available === true) setAvailable(scope);
        })
        .catch(() => {});
    };
    refresh();
    const watch = AppState.addEventListener("change", (status) => {
      if (status === "active") refresh();
      else {
        request.current++;
        setAvailable(null);
      }
    });
    return () => {
      live = false;
      watch.remove();
    };
  }, [source, chatId, scope]);
  useEffect(() => {
    if (!hostId || !chatId) return;
    return onShareAvailability(hostId, chatId, (next) => {
      request.current++;
      setAvailable(next === true ? scope : null);
    });
  }, [hostId, chatId, scope]);
  return !!source && available === scope;
}
