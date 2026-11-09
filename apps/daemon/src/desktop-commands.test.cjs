const test = require("node:test");
const assert = require("node:assert/strict");
const { createDesktopCommands } = require("./desktop-commands.cjs");

test("desktop capability calls reach the original owner and another connection cannot answer them", async () => {
  const port = createDesktopCommands();
  let request;
  port.register("desktop", ["editor:list"], (value) => {
    request = value;
  });
  assert.equal(port.list().find((item) => item.available).name, "desktop:editor:list");
  const result = port.invoke("editor:list", []);
  assert.equal(request.method, "editor:list");
  assert.throws(() => port.respond("intruder", { id: request.id, result: [] }), /Unknown/);
  port.respond("desktop", { id: request.id, result: [{ id: "code" }] });
  assert.deepEqual(await result, [{ id: "code" }]);
  port.close();
});

test("disconnects fail outstanding commands without replaying and missing capabilities fail explicitly", async () => {
  const port = createDesktopCommands();
  let calls = 0;
  port.register("desktop", ["image:copy"], () => {
    calls++;
  });
  const result = port.invoke("image:copy", ["/image.png"]);
  port.disconnect("desktop");
  await assert.rejects(result, { code: "OUTCOME_UNKNOWN" });
  assert.equal(calls, 1);
  assert.equal(port.list().find((item) => item.name === "desktop:image:copy").available, false);
  await assert.rejects(port.invoke("image:copy", []), { code: "CAPABILITY_UNAVAILABLE" });
});
