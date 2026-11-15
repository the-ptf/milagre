import { useEffect, useRef, useState } from "react";

/** The find bar belongs to one open chat; ⌘F again while it is open refocuses and selects its text. */
export function useFindInChat({
  canOpen,
  shownSessionId,
  messageCount,
  openChat,
}: {
  canOpen: boolean;
  /** The Chat on screen in the chat view, or undefined over the canvas or Routines. */
  shownSessionId: number | undefined;
  messageCount: number;
  openChat: (sessionId: number) => void;
}) {
  const [findOpen, setFindOpen] = useState(false);
  const [findSignal, setFindSignal] = useState(0);
  const [findSeed, setFindSeed] = useState<string | undefined>();
  const findRef = useRef({ open: false, canOpen: false });
  findRef.current = { open: findOpen, canOpen };
  function openFind(seed?: string) {
    if (!findRef.current.canOpen) return;
    setFindSeed(seed);
    setFindOpen(true);
    setFindSignal((current) => current + 1);
  }
  useEffect(() => setFindOpen(false), [shownSessionId]);
  const pendingFind = useRef<{ sessionId: number; term: string } | null>(null);
  useEffect(() => {
    const pending = pendingFind.current;
    if (!pending || shownSessionId !== pending.sessionId || !messageCount) return;
    pendingFind.current = null;
    openFind(pending.term);
  }, [shownSessionId, messageCount]);
  function openMessage(sessionId: number, term: string) {
    if (shownSessionId === sessionId) {
      openFind(term);
      return;
    }
    pendingFind.current = { sessionId, term };
    openChat(sessionId);
  }
  return { findOpen, setFindOpen, findSignal, findSeed, findRef, openFind, openMessage };
}
