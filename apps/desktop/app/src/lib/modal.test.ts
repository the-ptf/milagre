import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { appShortcutsBlocked, isModalOpen } from "./modal.ts";

// Whether a modal is open is decided in one place, lib/modal.ts. A card with role="dialog" (an approval, a
// question, a popover) is not a modal: the shortcuts keep working over it. Checking the role by hand is how
// ⌘K, ⌘N and ⌘F went dead while a chat waited on the user.
const SRC = join(import.meta.dirname, "..");
const OWNER = join(import.meta.dirname, "modal.ts");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && path !== OWNER ? [path] : [];
  });
}

function offenders(pattern: RegExp) {
  return sources(SRC).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) => (pattern.test(line) ? [`${relative(SRC, path)}:${index + 1}`] : [])),
  );
}

test("no module decides that a modal is open by querying for it", () => {
  assert.deepEqual(offenders(/querySelector\([^)]*(\[role="dialog"\]|aria-modal="true"\]|dialog\[open\])/), [], "Use isModalOpen from lib/modal instead");
});

// A document with these open dialogs (true marks the Settings modal) and, optionally, an aria-modal panel.
function page(dialogs: boolean[], panel = false) {
  const open = dialogs.map((settings) => ({ hasAttribute: (name: string) => settings && name === "data-settings-modal" }));
  return {
    querySelectorAll: () => open,
    querySelector: (selector: string) => (selector === "dialog[open]" ? (open[0] ?? null) : panel ? {} : null),
  } as unknown as ParentNode;
}

test("the Settings modal lets the app's shortcuts through; any other modal blocks them", () => {
  assert.equal(appShortcutsBlocked(page([])), false);
  assert.equal(appShortcutsBlocked(page([true])), false, "Settings alone: ⌘K and the rest still run, in App and in a Link");
  assert.equal(isModalOpen(page([true])), true, "but Settings is still a modal, so Escape and typing stay with it");
  assert.equal(appShortcutsBlocked(page([true, false])), true, "a dialog opened over Settings blocks them");
  assert.equal(appShortcutsBlocked(page([false])), true);
  assert.equal(appShortcutsBlocked(page([true], true)), true, "an aria-modal panel blocks them");
});
