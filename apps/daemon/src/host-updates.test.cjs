const test = require("node:test");
const assert = require("node:assert/strict");
const { createDesktopCommands } = require("./desktop-commands.cjs");
const { APP_UPDATE_METHODS, createHostUpdates } = require("./host-updates.cjs");

/** A desktop app registered with the host, running a stand-in updater that answers in the order calls arrive. */
function desktopWith(t, state, { methods = ["update:state", "update:check", "update:install", "app:version", "editor:list"] } = {}) {
  const port = createDesktopCommands();
  // A check or install the stand-in never finishes is dropped with it.
  t.after(() => port.close());
  const sent = [];
  const updater = {
    state,
    "update:state": () => updater.state,
    "update:check": () => {
      updater.state = { ...updater.state, status: "checking" };
      return new Promise(() => {});
    },
    "update:install": () => {
      if (updater.state.status === "downloaded") updater.state = { ...updater.state, status: "installing" };
      return new Promise(() => {});
    },
    "app:version": () => "0.232.0",
  };
  port.register("desktop", methods, (request) => {
    sent.push(request.method);
    const answer = updater[request.method]?.();
    if (answer instanceof Promise) return;
    queueMicrotask(() => {
      // A desktop that went away meanwhile answers nothing.
      try {
        port.respond("desktop", { id: request.id, result: answer });
      } catch {}
    });
  });
  return { port, sent, updater, updates: createHostUpdates(port) };
}

test("the phone and paired desktops get three update commands", () => {
  assert.deepEqual([...APP_UPDATE_METHODS], ["app-update:state", "app-update:check", "app-update:install"]);
});

test("app-update:state is the desktop updater's state and the version the app runs", async (t) => {
  const { updates, sent } = desktopWith(t, { status: "downloaded", version: "0.233.0", progress: 100, auto: false });
  assert.deepEqual(await updates.invoke("app-update:state"), { status: "downloaded", version: "0.233.0", progress: 100, auto: false, current: "0.232.0" });
  assert.deepEqual(sent.toSorted(), ["app:version", "update:state"], "nothing else of the desktop's commands is reached");
});

test("with no desktop app open on the Mac, the state is null and check answers the same", async () => {
  const updates = createHostUpdates(createDesktopCommands());
  assert.equal(await updates.invoke("app-update:state"), null);
  assert.equal(await updates.invoke("app-update:check"), null);
  await assert.rejects(updates.invoke("app-update:install"), /No update is ready to install/);
});

test("a check starts on the desktop and answers at once with the check begun", async (t) => {
  const { updates, sent } = desktopWith(t, { status: "up-to-date", version: null, progress: 0 });
  const state = await updates.invoke("app-update:check");
  assert.equal(state.status, "checking");
  assert.equal(sent[0], "update:check", "the check goes out before the read that answers");
});

test("install needs a downloaded update, then restarts the desktop and answers with the install begun", async (t) => {
  const { updates, sent, updater } = desktopWith(t, { status: "downloading", version: "0.233.0", progress: 40 });
  await assert.rejects(updates.invoke("app-update:install"), /No update is ready to install/);
  assert.equal(sent.includes("update:install"), false);
  updater.state = { status: "downloaded", version: "0.233.0", progress: 100 };
  const state = await updates.invoke("app-update:install");
  assert.equal(state.status, "installing");
  assert.equal(state.current, "0.232.0");
  assert.ok(sent.includes("update:install"));
});

test("an install whose restart closes the desktop before it answers still reads as installing", async (t) => {
  const { port, updates, updater } = desktopWith(t, { status: "downloaded", version: "0.233.0", progress: 100 });
  updater["update:install"] = () => {
    port.disconnect("desktop");
    return new Promise(() => {});
  };
  const state = await updates.invoke("app-update:install");
  assert.equal(state.status, "installing");
  assert.equal(state.version, "0.233.0");
});
