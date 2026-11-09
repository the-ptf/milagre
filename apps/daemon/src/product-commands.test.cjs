const test = require("node:test");
const assert = require("node:assert/strict");
const { runProductCommand } = require("./product-commands.cjs");
test("computer add accepts its label shortcut with positional and named links", async () => {
  const calls = [];
  const client = {
    call: async (method, args) => {
      calls.push([method, args]);
      return { ok: true };
    },
  };
  await runProductCommand(client, ["computers", "add", "link"], { flags: [["name", "Box"]] });
  await runProductCommand(client, ["computers", "add"], {
    flags: [
      ["link", "link"],
      ["name", "Box"],
    ],
  });
  assert.deepEqual(calls, [
    ["computers:add", ["link", { name: "Box" }]],
    ["computers:add", ["link", { name: "Box" }]],
  ]);
  await assert.rejects(
    runProductCommand(client, ["computers", "add"], {
      flags: [
        ["link", "link"],
        ["name", true],
      ],
    }),
    /Invalid arguments/,
  );
  assert.equal(calls.length, 2);
});
