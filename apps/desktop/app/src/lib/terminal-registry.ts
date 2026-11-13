import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalFollower } from "@milagre/shared/terminal-client";

// The open xterms, without xterm itself: closing, fitting, focusing and copying act on Terminals already built, so the
// window's first load doesn't carry xterm (about 430 KB of script). terminal-sessions.ts builds them, loaded with the
// first Terminal shown (loadTerminalView).

export type Session = {
  id: string;
  chatId: string;
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  follower: TerminalFollower;
  opened: boolean;
  /** Draws the shown Terminal on the GPU; null for one out of view, or where WebGL failed. */
  webgl: WebglAddon | null;
  /** The size waiting to be sent to the PTY while the panel is still being resized. */
  sizing: number | null;
};
export const sessions = new Map<string, Session>();
// The PTY learns a new size once the panel has stopped moving: every size on the way would make the program in front
// redraw its whole screen (vim, htop, an agent's TUI), and that redraw is more output to read back.
const PTY_RESIZE_MS = 100;

let view: Promise<typeof import("./terminal-sessions")> | null = null;
/** The module that builds xterms, loaded once: asked for as soon as a Chat has a Terminal, so it is there when one shows. */
export function loadTerminalView() {
  // A failed load (the app updated under the window) is tried again next time.
  view ??= import("./terminal-sessions").catch((error: unknown) => {
    view = null;
    throw error;
  });
  return view;
}

/** Clears the selection too: the next Ctrl+C then interrupts, as in Windows Terminal. */
export function copySelection({ term }: Session) {
  const text = term.getSelection();
  if (!text) return;
  term.clearSelection();
  void navigator.clipboard.writeText(text).catch(() => {});
}

/** A clipboard with no text, such as an image, sends the program in front the key: an agent's TUI reads it by itself. */
export function paste({ term, follower }: Session) {
  void navigator.clipboard
    .readText()
    .then((text) => (text ? term.paste(text) : follower.send("\x16")))
    .catch(() => {});
}

export function terminalHasSelection(id: string) {
  return Boolean(sessions.get(id)?.term.hasSelection());
}

export function copyTerminalSelection(id: string) {
  const session = sessions.get(id);
  if (session) copySelection(session);
}

export function pasteIntoTerminal(id: string) {
  const session = sessions.get(id);
  if (session) paste(session);
}

/** Sends the PTY the xterm's size once it has held still; a size claimed again before then replaces it. */
export function claimSize(session: Session) {
  if (session.sizing !== null) window.clearTimeout(session.sizing);
  session.sizing = window.setTimeout(() => {
    session.sizing = null;
    session.follower.resize(session.term.cols, session.term.rows);
  }, PTY_RESIZE_MS);
}

/** Fits the Terminal to its panel and claims the PTY's size for this window: the last viewer to fit or type sets it. */
export function fitTerminal(id: string) {
  const session = sessions.get(id);
  if (!session?.opened || !session.element.isConnected || !session.element.clientWidth || !session.element.clientHeight) return;
  try {
    session.fit.fit();
  } catch {
    return;
  }
  claimSize(session);
}

export function focusTerminal(id: string) {
  const session = sessions.get(id);
  if (!session?.opened) return;
  session.term.focus();
  session.follower.resize(session.term.cols, session.term.rows);
}

export function terminalHasFocus(id: string) {
  const session = sessions.get(id);
  return Boolean(session?.term.textarea && document.activeElement === session.term.textarea);
}

export function dispose(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.sizing !== null) window.clearTimeout(session.sizing);
  session.follower.stop();
  if (session.term.textarea && document.activeElement === session.term.textarea) window.milagre.setTerminalFocused(false);
  session.term.dispose();
  session.element.remove();
}

/** Ends viewers for Terminals the host no longer lists. */
export function pruneTerminals(chatId: string, live: Set<string>) {
  for (const session of sessions.values()) if (session.chatId === chatId && !live.has(session.id)) dispose(session.id);
}
