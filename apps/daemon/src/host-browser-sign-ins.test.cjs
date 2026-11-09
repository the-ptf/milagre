const test = require("node:test");
const assert = require("node:assert/strict");
const { createDesktopCommands } = require("./desktop-commands.cjs");
const { BROWSER_SIGN_IN_METHODS, createHostBrowserSignIns } = require("./host-browser-sign-ins.cjs");

function setup(t, { methods = ["browser-panel:clear-sign-ins", "editor:list"], computers = [{ id: "studio", name: "Studio", online: true }] } = {}) {
  const port = createDesktopCommands();
  t.after(() => port.close());
  const sent = [];
  port.register("desktop", methods, (request) => {
    sent.push([request.method, request.args]);
    queueMicrotask(() => port.respond("desktop", { id: request.id, result: { cleared: true } }));
  });
  return { signIns: createHostBrowserSignIns({ desktop: port, computers: () => computers }), sent };
}

test("the phone sees this Mac's sign-ins and each paired computer's", async (t) => {
  const { signIns } = setup(t);
  assert.deepEqual(BROWSER_SIGN_IN_METHODS, ["browser:sign-ins", "browser:sign-ins:clear"]);
  assert.deepEqual(await signIns.invoke("browser:sign-ins", []), {
    sessions: [
      { id: "local", name: null },
      { id: "studio", name: "Studio" },
    ],
  });
});

test("a sign-out reaches the desktop app's clear for that session only", async (t) => {
  const { signIns, sent } = setup(t);
  assert.deepEqual(await signIns.invoke("browser:sign-ins:clear", ["studio"]), { cleared: true });
  assert.deepEqual(await signIns.invoke("browser:sign-ins:clear", ["local"]), { cleared: true });
  await assert.rejects(signIns.invoke("browser:sign-ins:clear", ["santo"]), /no Browser sign-ins for that computer/);
  await assert.rejects(signIns.invoke("browser:sign-ins:clear", ["editor:list"]), /no Browser sign-ins/);
  assert.deepEqual(sent, [
    ["browser-panel:clear-sign-ins", ["studio"]],
    ["browser-panel:clear-sign-ins", ["local"]],
  ]);
});

test("with no desktop app open, a sign-out says so", async (t) => {
  const { signIns } = setup(t, { methods: ["editor:list"] });
  await assert.rejects(signIns.invoke("browser:sign-ins:clear", ["local"]), (error) => error.code === "CAPABILITY_UNAVAILABLE");
});
