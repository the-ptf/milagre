const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { defaultKeybindings, defaultRulesFor } = require("@milagre/shared/keybindings");
const { createRuntime } = require("./runtime.cjs");

test("Keybindings: the host keeps keybindings.json and every change reaches the listeners", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-runtime-keybindings-")));
  const events = [];
  const dataDir = path.join(dir, "profile");
  const runtime = createRuntime({
    dataDir,
    worktreeRoot: path.join(dir, "worktrees"),
    registryRoots: [],
    environmentReady: Promise.resolve(),
    titleModels: {},
    expandSkills: false,
    emit: (channel, payload) => events.push([channel, payload]),
    agentCli: async () => ({ command: "/fake" }),
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (const method of ["keybindings:read", "keybindings:set-command", "keybindings:reset-command", "keybindings:reset"])
    assert.ok(runtime.methods.includes(method), method);

  const file = path.join(dataDir, "keybindings.json");
  const state = await runtime.invoke("keybindings:read", []);
  assert.deepEqual(state, { path: file, rules: defaultKeybindings(), issues: [] });

  const changed = await runtime.invoke("keybindings:set-command", ["chat.new", [{ key: "mod+u" }]]);
  assert.deepEqual(
    changed.rules.filter((rule) => rule.command === "chat.new"),
    [{ key: "mod+u", command: "chat.new" }],
  );
  assert.deepEqual(
    events.filter(([channel]) => channel === "keybindings:changed"),
    [["keybindings:changed", changed]],
  );

  await assert.rejects(runtime.invoke("keybindings:set-command", ["no.such", []]), /Unknown keybinding command/);
  const reset = await runtime.invoke("keybindings:reset-command", ["chat.new"]);
  assert.deepEqual(
    reset.rules.filter((rule) => rule.command === "chat.new"),
    defaultRulesFor("chat.new"),
  );
  assert.deepEqual((await runtime.invoke("keybindings:reset", [])).rules, defaultKeybindings());
  assert.equal(events.filter(([channel]) => channel === "keybindings:changed").length, 3);
});
