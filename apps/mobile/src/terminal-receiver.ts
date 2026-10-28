import { XTERM_CSS, XTERM_FIT_JS, XTERM_JS } from "./xterm-bundle.gen.ts";

/** The colors the phone's Terminal draws with: the theme's 16 ANSI colors, cursor and selection. */
export type TerminalTheme = {
  scheme: "light" | "dark";
  background: string;
  ink: string;
  ink3: string;
  accent: string;
  ansi: string[];
  cursor: string;
  selection: string;
};

/**
 * What the WebView tells React Native: it is ready at a size, the user typed (`input`), the screen's size changed, or a
 * held Ctrl was used. Everything else crosses the other way as calls to the window functions in the script below.
 */
export type TerminalViewMessage =
  | { channel: "milagre-terminal"; event: "ready"; cols: number; rows: number }
  | { channel: "milagre-terminal"; event: "input"; data: string }
  | { channel: "milagre-terminal"; event: "resize"; cols: number; rows: number }
  | { channel: "milagre-terminal"; event: "ctrl-used" }
  /** xterm has parsed the output sent with this id. */
  | { channel: "milagre-terminal"; event: "wrote"; id: number };

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** xterm's theme for the phone, the same palette desktop's panel uses. */
export function xtermTheme(theme: TerminalTheme): Record<string, string> {
  const colors = theme.ansi;
  const named: Record<string, string> = {};
  NAMES.forEach((name, index) => {
    const normal = colors[index];
    const bright = colors[index + 8];
    if (normal !== undefined) named[name] = normal;
    if (bright !== undefined) named[`bright${name.charAt(0).toUpperCase()}${name.slice(1)}`] = bright;
  });
  return {
    ...named,
    background: theme.background,
    foreground: theme.ink,
    cursor: theme.cursor,
    cursorAccent: theme.background,
    selectionBackground: theme.selection,
  };
}

/** A value as a script literal that can't end the page's <script> element. */
export const scriptValue = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

// Runs in the WebView. The host's output arrives through terminalWrite/terminalReset, each answered with `wrote` once
// xterm has parsed it, so the app reads no faster than the page draws; keys go back as `input`. A held
// Ctrl (the key bar's) turns the next letter into its control character, as a hardware keyboard's Ctrl would.
const SCRIPT = `
(function () {
  var post = function (message) {
    message.channel = "milagre-terminal";
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  var element = document.getElementById("terminal");
  var term = new Terminal({ fontFamily: "Menlo, monospace", fontSize: 12, lineHeight: 1.15, scrollback: 10000, cursorBlink: true, theme: INITIAL_THEME });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(element);
  var ctrl = false;
  // A dead key (an accent or quote on many keyboards, the Portuguese one's ' and ") starts a composition. WebKit inserts
  // the key's own character while it waits for the next key, and xterm sends that at once and then the composed text at
  // the end (a quote and then the quote with the next letter), so the quote came out twice. The character still being composed is dropped; what the
  // composition ends with is sent.
  var composing = null;
  var textarea = element.querySelector("textarea");
  if (textarea) {
    textarea.addEventListener("input", function (event) { if (event.inputType === "insertCompositionText") composing = event.data; }, true);
    textarea.addEventListener("compositionend", function () { composing = null; }, true);
  }
  term.onData(function (data) {
    if (composing !== null && data === composing) {
      composing = null;
      return;
    }
    if (ctrl && data.length === 1) {
      var code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
      ctrl = false;
      post({ event: "ctrl-used" });
    }
    post({ event: "input", data: data });
  });
  term.onResize(function (size) { post({ event: "resize", cols: size.cols, rows: size.rows }); });
  var refit = function () { try { fit.fit(); } catch (error) {} };
  new ResizeObserver(refit).observe(element);
  var wrote = function (id) { return function () { post({ event: "wrote", id: id }); }; };
  window.terminalWrite = function (data, id) { term.write(data, wrote(id)); };
  window.terminalReset = function (data, id) { term.reset(); term.write(data, wrote(id)); };
  window.terminalTheme = function (theme) { term.options.theme = theme; document.body.style.background = theme.background; };
  window.terminalFocus = function () { term.focus(); };
  window.terminalCtrl = function (held) { ctrl = held; };
  window.terminalSend = function (data) { post({ event: "input", data: data }); term.focus(); };
  refit();
  post({ event: "ready", cols: term.cols, rows: term.rows });
})();
`;

/** The WebView's whole page: xterm, its fit addon and the glue above, with no network access needed. */
export function createTerminalHtml(theme: TerminalTheme) {
  const initial = xtermTheme(theme);
  const script = SCRIPT.replace("INITIAL_THEME", scriptValue(initial));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>${XTERM_CSS}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${theme.background}}#terminal{position:absolute;inset:4px 8px 0 8px}.xterm .xterm-viewport{background-color:transparent}
</style></head><body><div id="terminal"></div><script>${XTERM_JS}</script><script>${XTERM_FIT_JS}</script><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}
