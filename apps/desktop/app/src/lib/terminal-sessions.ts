import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { followTerminal, type TerminalFollower } from "@milagre/shared/terminal-client";
import type { TerminalInfo } from "@milagre/shared/terminal";
import { THEME_EVENT } from "./theme-sheet";
import { isMac } from "./shortcut-hints";
import { removeTerminal, updateTerminal } from "./terminal-store";
import { bridgeForKey } from "./computer-bridge";

// One xterm per Terminal, kept while the Terminal runs. Switching Chats or tabs moves its element between panels
// instead of building it again, so scrollback and selection survive and nothing is read twice.

type Session = {
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
const sessions = new Map<string, Session>();
// The PTY learns a new size once the panel has stopped moving: every size on the way would make the program in front
// redraw its whole screen (vim, htop, an agent's TUI), and that redraw is more output to read back.
const PTY_RESIZE_MS = 100;
// Browsers keep a handful of WebGL contexts; only the shown Terminals draw on the GPU, so a few stay well under it.
let webglBroken = false;

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** The app's colors as xterm takes them; the panel's own surface shows through the transparent background. */
function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();
  const ansi: Record<string, string> = {};
  ANSI_NAMES.forEach((name, index) => {
    ansi[name] = color(`--ansi-${index}`);
    ansi[`bright${name[0]!.toUpperCase()}${name.slice(1)}`] = color(`--ansi-${index + 8}`);
  });
  return {
    ...ansi,
    background: "#00000000",
    foreground: color("--ink"),
    cursor: color("--cursor"),
    cursorAccent: color("--surface"),
    selectionBackground: color("--selection"),
  };
}

function fontFamily() {
  const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return mono || 'ui-monospace, "SF Mono", Menlo, monospace';
}

function reapplyTheme() {
  const theme = terminalTheme();
  for (const session of sessions.values()) session.term.options.theme = theme;
}

// THEME_EVENT fires after applyPalette changes the theme's colors.
let themeWatched = false;
function watchTheme() {
  if (themeWatched) return;
  themeWatched = true;
  window.addEventListener(THEME_EVENT, reapplyTheme);
}

function create(info: TerminalInfo): Session {
  watchTheme();
  const term = new Terminal({
    allowTransparency: true,
    cursorBlink: true,
    fontFamily: fontFamily(),
    fontSize: 12.5,
    lineHeight: 1.2,
    scrollback: 10_000,
    macOptionIsMeta: false,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // ⌘ shortcuts belong to the app (⌘T, ⌘K, ⌘1…9); ⌘C and ⌘V go through the window's Edit menu to xterm's copy and paste.
  term.attachCustomKeyEventHandler((event) => !(isMac ? event.metaKey : event.ctrlKey && event.shiftKey));
  const element = document.createElement("div");
  element.className = "h-full w-full";
  element.dataset.terminalId = info.id;
  const follower = followTerminal({
    terminalId: info.id,
    api: bridgeForKey(info.chatId).terminals,
    // The next read waits for xterm to have parsed this one: a flood is read as fast as it can be drawn, and the host
    // resets a viewer that falls behind to the newest output instead of xterm queueing it past its own limit.
    write: (data) => new Promise<void>((resolve) => term.write(data, resolve)),
    reset: (data) =>
      new Promise<void>((resolve) => {
        term.reset();
        term.write(data, resolve);
      }),
    info: updateTerminal,
    ended: () => {
      dispose(info.id);
      removeTerminal(info.chatId, info.id);
    },
  });
  term.onData((data) => follower.send(data));
  term.onBinary((data) => follower.send(data));
  const session: Session = { id: info.id, chatId: info.chatId, term, fit, element, follower, opened: false, webgl: null, sizing: null };
  term.onResize(() => claimSize(session));
  sessions.set(info.id, session);
  return session;
}

/** Shows the Terminal in `container`, building its xterm the first time. */
export function attachTerminal(info: TerminalInfo, container: HTMLElement) {
  const session = sessions.get(info.id) ?? create(info);
  if (session.element.parentElement !== container) container.replaceChildren(session.element);
  if (!session.opened) {
    session.term.open(session.element);
    session.opened = true;
    // Focus listeners need the textarea xterm makes on open.
    session.term.textarea?.addEventListener("focus", () => window.milagre.setTerminalFocused(true));
    session.term.textarea?.addEventListener("blur", () => window.milagre.setTerminalFocused(false));
  }
  drawOnGpu(session);
  fitTerminal(info.id);
  return session;
}

/** WebGL for the Terminal just shown, none for those out of view; the DOM renderer when the GPU can't. */
function drawOnGpu(shown: Session) {
  for (const session of sessions.values()) {
    if (session === shown || session.element.isConnected || !session.webgl) continue;
    session.webgl.dispose();
    session.webgl = null;
  }
  if (shown.webgl || webglBroken) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      if (shown.webgl === webgl) shown.webgl = null;
    });
    shown.term.loadAddon(webgl);
    shown.webgl = webgl;
  } catch {
    webglBroken = true;
  }
}

/** Sends the PTY the xterm's size once it has held still; a size claimed again before then replaces it. */
function claimSize(session: Session) {
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
