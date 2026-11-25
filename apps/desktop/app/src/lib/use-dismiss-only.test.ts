import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

// Transient surfaces close through lib/use-dismiss.ts: an outside press or the window losing focus (docs/agents/ui.md,
// Popovers and menus). A press or blur listener on the whole document or window is how a hand-rolled dismiss starts, so
// each one outside use-dismiss.ts is listed here with what it does instead. Listeners on an element (a drag handle, a
// scroller, a text field) are not affected.
const SRC = join(import.meta.dirname, "..");
const OWNER = join("lib", "use-dismiss.ts");

const ALLOWED: Record<string, string> = {
  [`${join("components", "useWorktreePullRequests.ts")} window blur pause`]: "pauses PR polling while the window is in the background",
  [`${join("lib", "shortcut-hints.ts")} window blur reset`]: "drops the held-modifier shortcut hints when the window loses focus",
  [`${join("lib", "shortcut-hints.ts")} window pointerdown reset`]: "drops the held-modifier shortcut hints on any click",
  [`${join("lib", "dictation-shortcut.ts")} window blur release`]: "releases the held Dictate key, whose keyup lands in another app",
  [`${join("components", "agents", "canvas-pan.ts")} window blur release`]:
    "releases a held Space on the design canvas, whose keyup lands in another app or a design's frame",
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

test("no document or window press or blur listener outside lib/use-dismiss.ts", () => {
  const listener =
    /\b(window|document|globalThis|ownerDocument|defaultView)(?:\.(?:body|documentElement))?\s*\??\.\s*addEventListener\(\s*["'`](pointerdown|mousedown|touchstart|blur|focusout)["'`]\s*,\s*([\w.]+)?/g;
  const unused = new Set(Object.keys(ALLOWED));
  const offenders = sources(SRC).flatMap((path) => {
    const file = relative(SRC, path);
    if (file === OWNER) return [];
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(listener)].flatMap((match) => {
      const key = `${file} ${match[1]} ${match[2]} ${match[3] ?? "(inline)"}`;
      if (unused.delete(key)) return [];
      return [`${file}:${text.slice(0, match.index).split("\n").length} ${match[1]} ${match[2]}`];
    });
  });
  assert.deepEqual(offenders, [], "Close popovers, menus and pickers with useDismiss from lib/use-dismiss.ts; it handles outside presses and window blur");
  assert.deepEqual([...unused], [], "These allowed listeners are gone: delete their entries from ALLOWED");
});
