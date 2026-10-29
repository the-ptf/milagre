const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KEYBINDING_COMMANDS, defaultKeybindings, defaultRulesFor } = require("@milagre/shared/keybindings");
const { createKeybindings, lenientJson } = require("./keybindings.cjs");

function setup(t, { watch = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-keybindings-"));
  const file = path.join(dir, "nested", "keybindings.json");
  const events = [];
  const keybindings = createKeybindings({ file, watch, emit: (channel, payload) => events.push([channel, payload]) });
  t.after(() => {
    keybindings.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, seenFile: path.join(dir, "nested", "keybindings.seen.json"), events, keybindings };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("a missing file is seeded with the defaults and every command is marked seen", (t) => {
  const { file, seenFile, keybindings, events } = setup(t);
  const state = keybindings.read();
  assert.equal(state.path, file);
  assert.deepEqual(state.rules, defaultKeybindings());
  assert.deepEqual(state.issues, []);
  assert.deepEqual(json(file), defaultKeybindings());
  assert.deepEqual(
    json(seenFile),
    KEYBINDING_COMMANDS.map((command) => command.id),
  );
  assert.deepEqual(events, [], "reading emits nothing");
});

test("a command a newer Milagre brings gets its defaults once, and an unbound command stays unbound", (t) => {
  const { file, seenFile, keybindings } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rules = defaultKeybindings().filter((rule) => rule.command !== "chat.find" && rule.command !== "terminal.new");
  fs.writeFileSync(file, JSON.stringify(rules));
  // chat.find was seen and unbound by the user; terminal.new is new.
  const seen = KEYBINDING_COMMANDS.map((command) => command.id).filter((id) => id !== "terminal.new");
  fs.writeFileSync(seenFile, JSON.stringify(seen));
  const state = keybindings.read();
  assert.deepEqual(
    state.rules.filter((rule) => rule.command === "terminal.new"),
    defaultRulesFor("terminal.new"),
  );
  assert.deepEqual(
    state.rules.filter((rule) => rule.command === "chat.find"),
    [],
  );
  assert.equal(json(file).filter((rule) => rule.command === "terminal.new").length, 1, "written back");
  assert.ok(json(seenFile).includes("terminal.new"));
  // Reading again changes nothing.
  assert.deepEqual(keybindings.read(), state);
  assert.equal(json(file).filter((rule) => rule.command === "terminal.new").length, 1);
});

test("invalid JSON keeps the file, reads as the defaults with an issue, and refuses edits", (t) => {
  const { file, keybindings, events } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "[ { nope ");
  const state = keybindings.read();
  assert.deepEqual(state.rules, defaultKeybindings());
  assert.match(state.issues[0], /^keybindings\.json isn't valid JSON: .*Milagre uses the defaults until it is fixed\.$/);
  assert.equal(fs.readFileSync(file, "utf8"), "[ { nope ", "left alone");
  assert.throws(() => keybindings.setCommand("chat.new", [{ key: "mod+u" }]), /has errors; fix or reset it first/);
  assert.throws(() => keybindings.resetCommand("chat.new"), /has errors/);
  assert.equal(fs.readFileSync(file, "utf8"), "[ { nope ");
  assert.deepEqual(events, []);
  // Reset all is the way out.
  const fixed = keybindings.resetAll();
  assert.deepEqual(fixed.rules, defaultKeybindings());
  assert.deepEqual(fixed.issues, []);
  assert.deepEqual(json(file), defaultKeybindings());
  assert.equal(events.length, 1);
});

test("a file that is not an array reads as the defaults and is kept", (t) => {
  const { file, keybindings } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"key":"mod+k"}');
  const state = keybindings.read();
  assert.deepEqual(state.rules, defaultKeybindings());
  assert.equal(state.issues.length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), '{"key":"mod+k"}');
});

test("comments and trailing commas are read, and unreadable entries are reported but not rewritten away", (t) => {
  const { file, keybindings } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `[
  // my own
  { "key": "mod+u", "command": "chat.new", }, /* block */
  { "key": "mod+9000", "command": "no.such.command" },
]`;
  fs.writeFileSync(file, text);
  const state = keybindings.read();
  assert.deepEqual(state.rules.slice(0, 1), [{ key: "mod+u", command: "chat.new" }]);
  assert.equal(state.issues.length, 1);
  assert.match(state.issues[0], /Rule 2/);
  assert.equal(fs.readFileSync(file, "utf8"), text, "the file keeps what Milagre couldn't read");
  assert.equal(lenientJson('["// not a comment", "a,]"]'), '["// not a comment", "a,]"]');
});

test("setCommand replaces a command's rules, keeps the others, and emits the new state", (t) => {
  const { file, keybindings, events } = setup(t);
  const state = keybindings.setCommand("chat.new", [{ key: " Mod+U " }, { key: "mod+shift+u", when: "chatView && !terminalFocus" }]);
  assert.deepEqual(
    state.rules.filter((rule) => rule.command === "chat.new"),
    [
      { key: "Mod+U", command: "chat.new" },
      { key: "mod+shift+u", command: "chat.new", when: "chatView && !terminalFocus" },
    ],
  );
  assert.equal(state.rules.filter((rule) => rule.command === "settings.open").length, 1);
  assert.deepEqual(json(file), state.rules);
  assert.deepEqual(events, [["keybindings:changed", state]]);
  assert.deepEqual(keybindings.read(), state);
  // No keys unbinds the command for good.
  const unbound = keybindings.setCommand("chat.new", []);
  assert.deepEqual(
    unbound.rules.filter((rule) => rule.command === "chat.new"),
    [],
  );
  assert.deepEqual(
    keybindings.read().rules.filter((rule) => rule.command === "chat.new"),
    [],
  );
  assert.equal(events.length, 2);
});

test("resetCommand and resetAll restore the defaults", (t) => {
  const { keybindings, events } = setup(t);
  keybindings.setCommand("chat.new", [{ key: "mod+u" }]);
  keybindings.setCommand("theme.toggle", []);
  const one = keybindings.resetCommand("chat.new");
  assert.deepEqual(
    one.rules.filter((rule) => rule.command === "chat.new"),
    defaultRulesFor("chat.new"),
  );
  assert.deepEqual(
    one.rules.filter((rule) => rule.command === "theme.toggle"),
    [],
    "other commands stay as they were",
  );
  const all = keybindings.resetAll();
  assert.deepEqual(all.rules, defaultKeybindings());
  assert.equal(events.length, 4);
  assert.deepEqual(events.at(-1), ["keybindings:changed", all]);
});

test("bad input throws a clear error and changes nothing", (t) => {
  const { file, keybindings, events } = setup(t);
  keybindings.read();
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => keybindings.setCommand("no.such", [{ key: "mod+u" }]), /Unknown keybinding command/);
  assert.throws(() => keybindings.resetCommand("no.such"), /Unknown keybinding command/);
  assert.throws(() => keybindings.setCommand("chat.new", [{ key: "mod+" }]), /Keybinding 1 .*key Milagre can't read/);
  assert.throws(() => keybindings.setCommand("chat.new", [{ key: "mod+u", when: "((" }]), /when/);
  assert.throws(() => keybindings.setCommand("chat.new", [null]), /Keybinding 1/);
  assert.throws(() => keybindings.setCommand("chat.new", "mod+u"), /must be a list/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(events, []);
});

test("a hand edit is noticed and emitted once, and our own writes are not echoed", async (t) => {
  const { file, keybindings, events } = setup(t, { watch: true });
  keybindings.read();
  keybindings.setCommand("chat.new", [{ key: "mod+u" }]);
  await sleep(500);
  assert.equal(events.length, 1, "our own write is not emitted again");
  const rules = [{ key: "mod+i", command: "chat.new" }];
  fs.writeFileSync(file, JSON.stringify(rules));
  await sleep(600);
  assert.equal(events.length, 2);
  assert.equal(events[1][0], "keybindings:changed");
  assert.deepEqual(
    events[1][1].rules.filter((rule) => rule.command === "chat.new"),
    rules,
  );
  keybindings.close();
  fs.writeFileSync(file, "[]");
  await sleep(400);
  assert.equal(events.length, 2, "closed");
});
