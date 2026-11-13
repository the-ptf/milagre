// oxlint-disable eslint/no-underscore-dangle -- Tauri globals and the explicit smoke diagnostic contract.
import test from "node:test";
import assert from "node:assert/strict";

test("production bridge adapter routes RPCs, preserves errors, events and preference write order", async () => {
  const calls = [];
  const subscriptions = new Map();
  const listeners = new Map();
  const oldWindow = globalThis.window;
  globalThis.window = {
    addEventListener(channel, callback) {
      listeners.set(channel, callback);
    },
    setInterval() {},
    __TAURI__: {
      core: {
        async invoke(command, args) {
          calls.push({ command, args });
          if (command === "preferences_read") return { "milagre-settings": '{"theme":"dark"}' };
          if (command === "daemon" && args.method === "keybindings:read")
            return { rules: [{ key: "ctrl+alt+f5", command: "settings.open", when: "!chatView" }] };
          if (command === "daemon" && args.method === "chat:send") throw { code: "OUTCOME_UNKNOWN", message: "Connection closed after send" };
          return { command, args };
        },
      },
      event: {
        async listen(channel, callback) {
          subscriptions.set(channel, callback);
        },
      },
    },
  };
  try {
    const shim = await import("./electron-shim.js");
    await shim.initializeBridge();
    assert.equal(shim.ipcRenderer.sendSync("preferences:storage", "get", "milagre-settings").value, '{"theme":"dark"}');
    await shim.ipcRenderer.invoke("state:read", "/project");
    assert.deepEqual(calls.at(-1), { command: "daemon", args: { method: "state:read", args: ["/project"] } });
    await shim.ipcRenderer.invoke("artifact-preview:register", "<main>Document</main>");
    assert.equal(calls.at(-1).command, "native_call");
    await assert.rejects(shim.ipcRenderer.invoke("chat:send", { body: "test" }), { message: "Connection closed after send", code: "OUTCOME_UNKNOWN" });
    assert.equal(calls.filter((c) => c.args?.method === "chat:send").length, 1, "never retry commands after uncertain acknowledgement");
    const file = { name: "document.txt" };
    assert.match(shim.webUtils.getPathForFile(file), /^\/\.milagre-offline-attachments\/[^/]+\/document\.txt$/);
    assert.equal(shim.webUtils.getPathForFile(file), shim.webUtils.getPathForFile(file), "same File retains staged attachment identity");
    await shim.ipcRenderer.invoke("linear:connect", { window: true });
    assert.equal(calls.at(-1).command, "native_call");
    const received = [];
    const listener = (_event, payload) => received.push(payload);
    shim.ipcRenderer.on("agent:event", listener);
    subscriptions.get("daemon-event")({ payload: { channel: "agent:event", payload: { chatId: "one" } } });
    assert.deepEqual(received, [{ chatId: "one" }]);
    shim.ipcRenderer.removeListener("agent:event", listener);
    subscriptions.get("daemon-event")({ payload: { channel: "agent:event", payload: { chatId: "two" } } });
    assert.equal(received.length, 1);
    shim.ipcRenderer.sendSync("preferences:storage", "set", "milagre-settings", "one");
    shim.ipcRenderer.sendSync("preferences:storage", "set", "milagre-settings", "two");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      calls.filter((c) => c.command === "preferences_write").map((c) => c.args.value),
      ["one", "two"],
    );
    assert.equal(window.__rustDiagnostics.preferencesPending, 0);
    await shim.ipcRenderer.invoke("keybindings:read");
    assert.deepEqual(calls.at(-1), {
      command: "native_call",
      args: { method: "shortcuts:set", args: [[{ key: "f5", meta: false, control: true, alt: true, shift: false }]] },
    });
    subscriptions.get("daemon-event")({ payload: { channel: "keybindings:changed", payload: { rules: [] } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.at(-1), { command: "native_call", args: { method: "shortcuts:set", args: [[]] } });
  } finally {
    globalThis.window = oldWindow;
  }
});
