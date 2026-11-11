import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { forwardedShortcuts } from "./shortcuts.js";
import { fixtures } from "./shortcuts-fixtures.mjs";

test("native key fixtures stay aligned with the actual shared keybinding compiler", () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL("./shortcuts-fixtures.json", import.meta.url), "utf8")), fixtures());
});

test("custom rules replace defaults and preserve key modifiers regardless of when", () => {
  assert.deepEqual(forwardedShortcuts([]), []);
  assert.deepEqual(
    forwardedShortcuts([
      { command: "settings.open", key: "ctrl+alt+f5", when: "!chatView" },
      { command: "chat.new", key: "mod+p" },
      { command: "theme.toggle", key: "mod+shift+t", when: "chatView &&" },
    ]),
    [{ key: "f5", meta: false, control: true, alt: true, shift: false }],
  );
});
