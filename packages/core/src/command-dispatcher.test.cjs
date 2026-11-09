const test = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");
const { createCommandDispatcher, createRuntimeCommands } = require("./command-dispatcher.cjs");

test("runtime registration supplies discovery and invokes the original handler with its client context", () => {
  const registry = createRuntimeCommands();
  const context = { clientId: "viewer" };
  registry.handle("browser:status", (caller, input) => ({ caller, input }));
  assert.deepEqual(registry.methods(), ["browser:status"]);
  assert.equal(registry.list()[0].command, "browser status");
  assert.deepEqual(registry.invoke("browser:status", [{ chatId: "p#1" }], context), { caller: context, input: { chatId: "p#1" } });
  assert.throws(() => registry.handle("browser:status", () => {}), /Duplicate command/);
  assert.throws(() => registry.invoke("browser:status", {}), /array/);
  assert.throws(() => registry.invoke("unknown"), /Unknown command/);
});

test("discovery and execution resolve the current caller's definitions, without retaining grants", async () => {
  let allowed = true;
  let calls = 0;
  const dispatcher = createCommandDispatcher({
    definitions: (caller) =>
      allowed && caller === "chat"
        ? [
            {
              name: "tasks_read",
              description: "Read tasks",
              input: {},
              readOnly: true,
              run: () => {
                calls++;
                return "tasks";
              },
            },
          ]
        : [],
  });
  assert.equal(dispatcher.list("chat")[0].name, "tasks_read");
  assert.equal(dispatcher.describe("chat", "tasks_read").inputSchema.additionalProperties, false);
  assert.equal((await dispatcher.run("chat", "tasks_read", {})).text, "tasks");
  assert.equal((await dispatcher.run("other", "tasks_read", {})).isError, true);
  allowed = false;
  assert.equal((await dispatcher.run("chat", "tasks_read", {})).isError, true);
  assert.equal(calls, 1);
});

test("CLI and MCP share strict validation, rich results and error formatting", async () => {
  let calls = 0;
  const dispatcher = createCommandDispatcher({
    definitions: () => [
      {
        name: "image",
        input: { title: z.string() },
        run: ({ title }) => {
          calls++;
          return { text: title, images: [{ base64: "AA==", mime: "image/png" }] };
        },
      },
    ],
  });
  assert.match((await dispatcher.run(null, "image", { title: "x", unknown: true })).text, /Invalid arguments/);
  assert.equal(calls, 0);
  assert.deepEqual(await dispatcher.run(null, "image", { title: "x" }), { text: "x", images: [{ base64: "AA==", mime: "image/png" }], isError: false });
  assert.throws(() => dispatcher.describe(null, "missing"), /unavailable/);
});
