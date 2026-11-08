import assert from "node:assert/strict";
import test from "node:test";
import { filterCommands, type Command } from "./commands.ts";
import { RECENT_LIMIT, recentCommandIds, recentCommands, rememberCommand, rememberedId } from "./recent-commands.ts";
import { settingsPageCommands } from "./settings-commands.ts";

function memory() {
  const saved = new Map<string, string>();
  return { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
}

const command = (id: string, extra: Partial<Command> = {}): Command => ({ id, label: id, group: "Actions", icon: "add", run: () => {}, ...extra });

test("keeps the last five commands, newest first, each once", () => {
  const storage = memory();
  for (const id of ["a", "b", "c", "d", "e", "f", "b"]) rememberCommand(id, storage);
  assert.deepEqual(recentCommandIds(storage), ["b", "f", "e", "d", "c"]);
  assert.equal(recentCommandIds(storage).length, RECENT_LIMIT);
});

test("a broken saved list reads as empty", () => {
  const storage = memory();
  storage.setItem("milagre.recentCommands", "{nope");
  assert.deepEqual(recentCommandIds(storage), []);
});

test("recent rows are copies in a Recent group, skipping commands this palette no longer has", () => {
  const rows = recentCommands([command("new-chat"), command("chat:4", { group: "Chats" })], ["chat:4", "gone", "new-chat"]);
  assert.deepEqual(
    rows.map((row) => [row.id, row.group]),
    [
      ["recent:chat:4", "Recent"],
      ["recent:new-chat", "Recent"],
    ],
  );
  assert.equal(rememberedId(rows[0]!), "chat:4");
});

test("Settings rows show only once something is typed, and not for the word settings alone", () => {
  const opened: [string, string | undefined][] = [];
  const commands = [command("settings", { label: "Settings" }), ...settingsPageCommands((section, row) => opened.push([section, row]))];
  assert.deepEqual(
    filterCommands(commands, "").map((item) => item.id),
    ["settings"],
  );
  const byWord = filterCommands(commands, "settings");
  assert.ok(byWord.some((item) => item.id === "settings-page:general"));
  assert.ok(!byWord.some((item) => item.label === "Chat order"), "a row is found by its own words, not by its group's");

  const order = filterCommands(commands, "chat order");
  const row = order.find((item) => item.label === "Chat order");
  assert.ok(row, "the Chat order row is found");
  assert.equal(row.detail, "General › Sidebar");
  void row.run();
  assert.deepEqual(opened, [["general", "Chat order"]]);

  const page = filterCommands(commands, "keybindings").find((item) => item.id === "settings-page:keybindings");
  assert.ok(page);
  void page.run();
  assert.deepEqual(opened.at(-1), ["keybindings", undefined]);
});
