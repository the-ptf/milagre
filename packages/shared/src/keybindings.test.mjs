import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEYBINDING_COMMANDS,
  addNewDefaults,
  canonicalKey,
  commandForEvent,
  compileRules,
  conflictsFor,
  defaultKeybindings,
  evaluateWhen,
  hasCommandModifier,
  isDefault,
  keyFromEvent,
  keyLabelFor,
  parseKey,
  parseWhen,
  primaryKeyFor,
  readRules,
  withCommandRules,
} from "./keybindings.mjs";

const press = (key, extra = {}) => ({ key, code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });

test("every command has a unique id and a key it can read", () => {
  const ids = KEYBINDING_COMMANDS.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const rule of defaultKeybindings()) assert.ok(parseKey(rule.key), rule.key);
});

test("parseKey reads modifiers, aliases and the plus key", () => {
  assert.deepEqual(parseKey("Mod+Shift+D"), { key: "d", mod: true, meta: false, ctrl: false, alt: false, shift: true });
  assert.equal(parseKey("cmd+left")?.key, "arrowleft");
  assert.equal(parseKey("mod++")?.key, "+");
  assert.equal(parseKey("mod+shift"), null);
  assert.equal(parseKey("mod+k+j"), null);
  assert.equal(parseKey("mod+nope"), null);
  assert.equal(parseKey(""), null);
});

test("canonicalKey treats mod as the platform's command key", () => {
  assert.equal(canonicalKey("mod+k", true), canonicalKey("cmd+K", true));
  assert.equal(canonicalKey("mod+k", false), canonicalKey("ctrl+k", false));
  assert.notEqual(canonicalKey("mod+k", true), canonicalKey("ctrl+k", true));
});

test("keyFromEvent reads punctuation and ⌥ letters from the physical key", () => {
  assert.equal(keyFromEvent(press("D", { metaKey: true, shiftKey: true }), true), "mod+shift+d");
  assert.equal(keyFromEvent(press("<", { code: "Comma", metaKey: true, shiftKey: true }), true), "mod+shift+,");
  assert.equal(keyFromEvent(press("˚", { code: "KeyK", metaKey: true, altKey: true }), true), "mod+alt+k");
  assert.equal(keyFromEvent(press("ArrowLeft", { ctrlKey: true, altKey: true }), false), "mod+alt+arrowleft");
  assert.equal(keyFromEvent(press("Meta", { metaKey: true }), true), null);
});

test("keyLabelFor draws Mac glyphs in ⌘⌃⌥⇧ order and words elsewhere", () => {
  assert.equal(keyLabelFor("mod+shift+d", true), "⌘⇧D");
  assert.equal(keyLabelFor("mod+alt+arrowleft", true), "⌘⌥←");
  assert.equal(keyLabelFor("mod+shift+d", false), "Ctrl+Shift+D");
  assert.equal(keyLabelFor("bad", true), null);
});

test("hasCommandModifier refuses keys that fire while typing", () => {
  assert.equal(hasCommandModifier("k"), false);
  assert.equal(hasCommandModifier("shift+k"), false);
  assert.equal(hasCommandModifier("alt+k"), true);
  assert.equal(hasCommandModifier("f5"), true);
});

test("parseWhen and evaluateWhen handle not, and, or and parentheses", () => {
  const tree = parseWhen("chatView && !(terminalFocus || editableFocus)");
  assert.ok(tree);
  assert.equal(evaluateWhen(tree, { chatView: true }), true);
  assert.equal(evaluateWhen(tree, { chatView: true, terminalFocus: true }), false);
  assert.equal(evaluateWhen(parseWhen("unknownKey"), {}), false);
  assert.equal(parseWhen("a &&"), null);
  assert.equal(parseWhen("(a"), null);
  assert.equal(parseWhen("a b"), null);
});

test("readRules keeps valid rules and says what it left out", () => {
  const { rules, issues } = readRules([
    { key: "mod+g", command: "terminal.toggle" },
    { key: "mod+g", command: "nope" },
    { key: "", command: "chat.new" },
    { key: "mod+t", command: "terminal.new", when: "terminalFocus &&" },
    "junk",
  ]);
  assert.deepEqual(rules, [{ key: "mod+g", command: "terminal.toggle" }]);
  assert.equal(issues.length, 4);
  assert.deepEqual(readRules({}).rules, []);
});

test("the last matching rule wins, and when gates it", () => {
  const compiled = compileRules([
    { key: "mod+k", command: "commandPalette.toggle" },
    { key: "mod+k", command: "terminal.new", when: "terminalFocus" },
  ]);
  const event = press("k", { metaKey: true });
  assert.equal(commandForEvent(compiled, event, {}, true), "commandPalette.toggle");
  assert.equal(commandForEvent(compiled, event, { terminalFocus: true }, true), "terminal.new");
  assert.equal(commandForEvent(compiled, press("k", { metaKey: true, shiftKey: true }), {}, true), null);
  // mod takes either ⌘ or Ctrl, as the window always did, but not both.
  assert.equal(commandForEvent(compiled, press("k", { ctrlKey: true }), {}, true), "commandPalette.toggle");
  assert.equal(commandForEvent(compiled, press("k", { metaKey: true, ctrlKey: true }), {}, true), null);
  // A rule naming the pressed modifier wins over a later mod rule that only allows it.
  const both = compileRules([
    { key: "ctrl+k", command: "chat.new" },
    { key: "mod+k", command: "commandPalette.toggle" },
  ]);
  assert.equal(commandForEvent(both, press("k", { ctrlKey: true }), {}, true), "chat.new");
  assert.equal(commandForEvent(both, press("k", { metaKey: true }), {}, true), "commandPalette.toggle");
});

test("conflictsFor names the other commands on the same key and when", () => {
  const rules = defaultKeybindings();
  assert.deepEqual(conflictsFor(rules, { key: "cmd+K", command: "chat.new" }, true), ["commandPalette.toggle"]);
  assert.deepEqual(conflictsFor(rules, { key: "mod+k", command: "commandPalette.toggle" }, true), []);
  assert.deepEqual(conflictsFor(rules, { key: "mod+k", command: "chat.new", when: "terminalFocus" }, true), []);
});

test("withCommandRules replaces a command's rules at the end, and isDefault notices", () => {
  const rules = defaultKeybindings();
  assert.equal(isDefault(rules, "chat.new"), true);
  const next = withCommandRules(rules, "chat.new", [{ key: "mod+shift+n" }]);
  assert.deepEqual(next.at(-1), { key: "mod+shift+n", command: "chat.new" });
  assert.equal(next.filter((rule) => rule.command === "chat.new").length, 1);
  assert.equal(isDefault(next, "chat.new"), false);
  assert.equal(primaryKeyFor(next, "chat.new"), "mod+shift+n");
  assert.equal(primaryKeyFor(withCommandRules(rules, "chat.new", []), "chat.new"), null);
});

test("addNewDefaults adds unseen commands once and keeps removed ones unbound", () => {
  const first = addNewDefaults([], []);
  assert.deepEqual(first.rules, defaultKeybindings());
  assert.equal(first.added, true);
  const unbound = withCommandRules(first.rules, "chat.new", []);
  const again = addNewDefaults(unbound, first.seen);
  assert.equal(again.added, false);
  assert.equal(
    again.rules.some((rule) => rule.command === "chat.new"),
    false,
  );
  // A newer Milagre brings designs.toggle: added once, after the rules there are.
  const without = withCommandRules(unbound, "designs.toggle", []);
  const newer = addNewDefaults(
    without,
    first.seen.filter((id) => id !== "designs.toggle"),
  );
  assert.deepEqual(newer.rules.at(-1), { key: "mod+shift+e", command: "designs.toggle" });
  assert.equal(
    newer.rules.some((rule) => rule.command === "chat.new"),
    false,
  );
  // An unseen command the file already binds keeps only its own rules.
  const kept = addNewDefaults(
    withCommandRules(without, "designs.toggle", [{ key: "mod+e" }]),
    first.seen.filter((id) => id !== "designs.toggle"),
  );
  assert.deepEqual(
    kept.rules.filter((rule) => rule.command === "designs.toggle"),
    [{ key: "mod+e", command: "designs.toggle" }],
  );
});
