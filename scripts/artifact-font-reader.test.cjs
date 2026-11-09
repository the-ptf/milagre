const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createDesignFontReader, restoreDesignFonts } = require("../packages/shared/src/design-font-cache.mjs");
const { onComputerConnection } = require("../apps/desktop/app/src/lib/computer-bridge.ts");

function fixture() {
  const filename = path.join(__dirname, "../apps/desktop/app/src/components/agents/ArtifactCanvas.tsx");
  const source = fs.readFileSync(filename, "utf8");
  const start = source.indexOf("const versionsRead =");
  const end = source.indexOf("const keptArtifact =", start);
  assert.ok(start > 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end) + "\nexports.readArtifact = readArtifact;", {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const listeners = new Set();
  const calls = [];
  let rejectFonts = false;
  const full = { format: "design", id: "home", version: 1, html: "<head><style>css</style></head>" };
  const local = {
    get: async (request) => {
      calls.push({ local: true, ...request });
      return full;
    },
  };
  const makeRemote = () => ({
    get: async (request) => {
      calls.push({ local: false, ...request });
      if (!request.fonts) return full;
      if (rejectFonts) throw Error("Error invoking remote method 'computers:invoke': Error: Invalid arguments: fonts not allowed");
      return { ...full, html: "<head></head>", fontKey: "key", ...(!request.fonts.have.includes("key") ? { fontCss: "css" } : {}) };
    },
  });
  let remote = makeRemote();
  const exports = {};
  const window = {
    milagre: {
      onComputersChanged: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
  };
  globalThis.window = window;
  vm.runInNewContext(code, {
    exports,
    createDesignFontReader,
    restoreDesignFonts,
    bridgeForKey: (key) => ({ artifacts: key.includes("|") ? remote : local }),
    isRemoteKey: (key) => key.includes("|"),
    onComputerConnection,
  });
  return {
    read: exports.readArtifact,
    full,
    calls,
    listeners,
    rejectFonts(value) {
      rejectFonts = value;
    },
    emit(computers) {
      for (const callback of listeners) callback({ computers });
    },
    replaceRemote() {
      remote = makeRemote();
    },
  };
}

test("desktop local reads stay full; remote reads negotiate and restore before the version cache", async () => {
  const f = fixture();
  await f.read("/p#1", "home", null);
  assert.equal(f.calls[0].fonts, undefined);
  assert.equal(f.listeners.size, 0);
  const first = await f.read("peer|/p#1", "home", 1);
  assert.equal(first.html, f.full.html);
  assert.equal(first.fontKey, undefined);
  assert.deepEqual([...f.calls[1].fonts.have], []);
  await f.read("peer|/p#1", "home", 1);
  assert.equal(f.calls.length, 2, "the restored version is cached");
  await f.read("peer|/p#1", "home", null);
  assert.deepEqual([...f.calls[2].fonts.have], ["key"]);
});

test("desktop reconnect retries negotiation; forgetting releases the listener and re-pair starts fresh", async () => {
  const f = fixture();
  f.rejectFonts(true);
  await f.read("peer|/p#1", "home", null);
  assert.equal(f.calls.length, 2, "wrapped rejection retries full HTML");
  await f.read("peer|/p#1", "home", null);
  assert.equal(f.calls.at(-1).fonts, undefined);
  f.emit([{ id: "peer", state: "offline" }]);
  f.rejectFonts(false);
  f.emit([{ id: "peer", state: "online" }]);
  await f.read("peer|/p#1", "home", null);
  assert.ok(f.calls.at(-1).fonts);
  assert.equal(f.listeners.size, 1);
  f.emit([]);
  assert.equal(f.listeners.size, 0);
  f.replaceRemote();
  await f.read("new-peer|/p#1", "home", null);
  assert.deepEqual([...f.calls.at(-1).fonts.have], []);
  assert.equal(f.listeners.size, 1);
  f.emit([]);
  assert.equal(f.listeners.size, 0);
});
