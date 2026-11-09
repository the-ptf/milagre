import { useEffect, useRef, useState } from "react";
import type { InboxSnapshot } from "@milagre/shared/attention";
import { onAnyAgentEvent } from "./computer-bridge";

const EMPTY: InboxSnapshot = { agents: [], items: [] };
// Agent events, state changes and the window coming back to the front read the inbox; this is only a safety net
// for a change none of them announced, so an idle window doesn't ask the daemon every few seconds.
const FALLBACK_READ_MS = 30_000;

/**
 * One request at a time, with streaming batches coalesced rather than fetching per text delta. A burst waits at most
 * 120 ms: the first event of it sets the read, later ones ride along, so a long stream of tool output can't keep
 * pushing the read back.
 */
export function useInbox() {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true,
      busy = false,
      again = false;
    let queued: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!live) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const next = await window.milagre.getInbox();
        if (live) {
          setSnapshot((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
          setError("");
        }
      } catch (failure) {
        if (live) {
          setSnapshot(EMPTY);
          setError(failure instanceof Error ? failure.message : "Could not load the inbox.");
        }
      } finally {
        busy = false;
        if (live) setLoading(false);
        if (again) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (queued !== undefined) return;
      queued = setTimeout(() => {
        queued = undefined;
        void load();
      }, 120);
    };
    refresh.current = () => void load();
    void load();
    // A hidden window keeps this pace too (timers there only ever run slower), and reads at once when it shows again.
    const timer = setInterval(() => void load(), FALLBACK_READ_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") schedule();
    };
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", onVisible);
    const offAgent = onAnyAgentEvent((payload) => {
      if (payload.event.type !== "text-delta") schedule();
    });
    const offState = window.milagre.onProjectState(schedule);
    const offRemote = window.milagre.onComputerEvent?.((event) => {
      if (event.channel === "project:state" || event.channel === "link:state") schedule();
    });
    const offLink = window.milagre.onLinkState?.(schedule);
    return () => {
      live = false;
      refresh.current = () => {};
      clearInterval(timer);
      clearTimeout(queued);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", onVisible);
      offAgent();
      offState();
      offRemote?.();
      offLink?.();
    };
  }, []);
  return { snapshot, error, loading, refresh: () => refresh.current() };
}
