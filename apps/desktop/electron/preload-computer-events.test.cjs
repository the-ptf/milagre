const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadPreload(controls) {
  const listeners = new Set();
  let exposed;
  let chrome;
  const originalArgv = process.argv;
  if (controls) process.argv = [...originalArgv, `--milagre-window-controls=${controls}`];
  const ipcRenderer = {
    on: (channel, listener) => channel === "computers:event" && listeners.add(listener),
    removeListener: (channel, listener) => channel === "computers:event" && listeners.delete(listener),
    invoke: async () => undefined,
    send() {},
  };
  const original = Module["_load"];
  Module["_load"] = function (request, ...rest) {
    if (request === "electron")
      return {
        ipcRenderer,
        webUtils: {},
        contextBridge: {
          exposeInMainWorld: (name, value) => {
            if (name === "milagreWindowChrome") chrome = value;
            if (name === "milagre") exposed = value;
          },
        },
      };
    return original.call(this, request, ...rest);
  };
  const file = path.join(__dirname, "preload.cjs");
  delete require.cache[file];
  try {
    require(file);
  } finally {
    Module["_load"] = original;
    process.argv = originalArgv;
  }
  const emit = (event) => {
    for (const listener of Array.from(listeners)) listener({}, event);
  };
  return { bridge: exposed, chrome, listeners, emit };
}

test("window decoration stays local and accepts only the configured control modes", () => {
  for (const mode of ["leading", "overlay", "external", "unknown"]) {
    const { bridge, chrome } = loadPreload(mode);
    assert.equal(chrome.controls, mode === "unknown" ? "external" : mode);
    assert.equal(bridge.on("remote").windowChrome, undefined);
  }
});

test("every computer subscription shares one computers:event listener, filtered per computer and channel", () => {
  const { bridge, listeners, emit } = loadPreload();
  assert.equal(listeners.size, 0);
  const got = [];
  const offs = [];
  for (let i = 0; i < 40; i++) offs.push(bridge.on("a").onProjectState((p) => got.push(["a", p])));
  const offB = bridge.on("b").onProjectState((p) => got.push(["b", p]));
  const all = [];
  const offAll = bridge.onComputerEvent((e) => all.push(e));
  assert.equal(listeners.size, 1, "one ipcRenderer listener however many subscriptions");
  emit({ computerId: "b", channel: "project:state", payload: 1 });
  emit({ computerId: "a", channel: "link:state", payload: 2 });
  assert.deepEqual(got, [["b", 1]]);
  assert.equal(all.length, 2);
  offB();
  emit({ computerId: "b", channel: "project:state", payload: 3 });
  assert.equal(got.length, 1, "unsubscribed callbacks stop hearing");
  for (const off of offs) off();
  offAll();
  assert.equal(listeners.size, 0, "the listener goes with the last subscription");
});
