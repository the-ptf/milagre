import { useEffect, useRef, useState } from "react";
import { chatKey } from "@milagre/shared/agent-runs";

/** The find bar belongs to one open chat; ⌘F again while it is open refocuses and selects its text. */
export function useFindInChat({
  canOpen,
  shownSessionId,
  shownProjectPath,
  messageCount,
  openChat,
  openChatKey,
}: {
  canOpen: boolean;
  /** The Chat on screen in the chat view, or undefined over the canvas or Routines. */
  shownSessionId: number | undefined;
  shownProjectPath: string | undefined;
  messageCount: number;
  openChat: (sessionId: number) => void;
  /** Opens a Chat of any Project, switching to it first. */
  openChatKey: (key: string) => void;
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
  const pendingFind = useRef<{ sessionId: number; projectPath?: string; term: string } | null>(null);
  useEffect(() => {
    const pending = pendingFind.current;
    if (!pending || shownSessionId !== pending.sessionId || !messageCount) return;
    if (pending.projectPath !== undefined && pending.projectPath !== shownProjectPath) return;
    pendingFind.current = null;
    openFind(pending.term);
  }, [shownSessionId, shownProjectPath, messageCount]);
  /** Opens the Chat with the find bar on `term`; a Chat of another Project (`projectPath`) opens that Project first. */
  function openMessage(sessionId: number, term: string, projectPath?: string) {
    const elsewhere = projectPath !== undefined && projectPath !== shownProjectPath;
    if (shownSessionId === sessionId && !elsewhere) {
      openFind(term);
      return;
    }
    pendingFind.current = { sessionId, projectPath, term };
    if (elsewhere) openChatKey(chatKey(projectPath, sessionId));
    else openChat(sessionId);
  }
  return { findOpen, setFindOpen, findSignal, findSeed, findRef, openFind, openMessage };
}
