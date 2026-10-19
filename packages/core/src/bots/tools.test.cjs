const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runTool } = require("../linked-tools.cjs");
const { createBotHome } = require("./home.cjs");
const { readMemory } = require("./memory.cjs");
const { BOT_TOOL_NAMES, createBotTools } = require("./tools.cjs");

async function harness(t) {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "milagre-bots-tools-"));
  t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }));
  const bot = { id: "ops", name: "Ops", homePath: await createBotHome(path.join(dir, "bots"), "ops") };
  const tools = createBotTools({ now: () => 5 });
  const call = (name, args) =>
    runTool(
      tools.definitions(`${bot.homePath}#1`, bot).find((tool) => tool.name === name),
      args,
    );
  return { bot, call, tools };
}

test("memory tools are defined for a bot", async (t) => {
  const { bot, tools } = await harness(t);
  assert.deepEqual(
    tools.definitions(`${bot.homePath}#1`, bot).map((tool) => [tool.name, tool.readOnly]),
    [
      ["memory_read", true],
      ["memory_write", false],
    ],
  );
});

test("memory_write reports the line count", async (t) => {
  const { bot, call } = await harness(t);
  assert.equal((await call("memory_write", { section: "a", text: "- b", mode: "append" })).text, "Saved. MEMORY.md has 3 of 200 lines.");
  assert.equal((await readMemory(bot.homePath)).text, "# Memory\n## a\n- b\n");
});

test("memory_read returns the file and its size", async (t) => {
  const { call } = await harness(t);
  await call("memory_write", { section: "a", text: "- b", mode: "append" });
  assert.equal((await call("memory_read", {})).text, "# Memory\n## a\n- b\n\n(3 of 200 lines)");
});

test("a full memory comes back as the tool's error", async (t) => {
  const { call } = await harness(t);
  await call("memory_write", { section: "a", text: Array.from({ length: 198 }, (_, index) => `- ${index}`).join("\n"), mode: "append" });
  const result = await call("memory_write", { section: "a", text: "- one more", mode: "append" });
  assert.equal(result.isError, true);
  assert.match(result.text, /MEMORY\.md is full: 200 lines max\./);
});

test("BOT_TOOL_NAMES lists every tool a bot's thread gets, for Bot rules to keep", () => {
  const bots = { chatOpen: async () => {}, chatStatus: async () => {}, chatSend: async () => {}, chatsMine: () => [] };
  const bot = { id: "ops", name: "Ops", homePath: "/home" };
  assert.deepEqual(
    createBotTools({ bots })
      .definitions("/home#1", bot)
      .map((tool) => tool.name)
      .sort(),
    [...BOT_TOOL_NAMES].sort(),
  );
});
