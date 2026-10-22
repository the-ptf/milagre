const test = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate } = require("node:timers/promises");
const { createDesktopCommandAdapter } = require("./desktop-commands.cjs");

test("native CLI calls and UI calls use the same handler, event context and error result", async () => {
  const calls = [];
  const ipc = new Map();
  const event = { sender: { id: 1 } };
  const adapter = createDesktopCommandAdapter({
    ipcMain: { handle: (name, handler) => ipc.set(name, handler) },
    runtime: () => ({
      invoke: async (...args) => {
        calls.push(args);
      },
    }),
    event: () => event,
  });
  let executions = 0;
  adapter.ipcMain.handle("editor:open", (context, input) => {
    assert.equal(context, event);
    executions++;
    return input;
  });
  await setImmediate();
  assert.deepEqual(calls[0], ["desktop:register", [{ methods: ["editor:open"] }]]);
  assert.equal(ipc.get("editor:open")(event, "UI"), "UI");
  await adapter.receive({ id: "call", method: "editor:open", args: ["CLI"] });
  assert.deepEqual(calls.at(-1), ["desktop:respond", [{ id: "call", result: "CLI" }]]);
  assert.equal(executions, 2);
  await adapter.receive({ id: "bad", method: "missing", args: [] });
  assert.match(calls.at(-1)[1][0].error.message, /unavailable/);
});
