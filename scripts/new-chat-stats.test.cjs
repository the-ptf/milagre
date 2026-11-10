const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

// Load the real phone stores and hook; replace only native storage and React's snapshot reader.
function phone(storage, read = async (key) => storage.get(key) ?? null) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const source = fs.readFileSync(file, "utf8");
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports,
      TextDecoder,
      TextEncoder,
      require(id) {
        if (id === "react") return { useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
        if (id === "expo-secure-store")
          return {
            getItem: (key) => storage.get(key) ?? null,
            getItemAsync: read,
            setItemAsync: async (key, value) => storage.set(key, value),
            deleteItemAsync: async (key) => storage.delete(key),
          };
        if (id.startsWith(".")) return load(path.resolve(path.dirname(file), id.endsWith(".ts") ? id : id + ".ts"));
        return require(id);
      },
    });
    return exports;
  }
  const root = path.resolve(__dirname, "../apps/mobile/src");
  return { store: load(path.join(root, "hosts-native.ts")), hook: () => load(path.join(root, "chat-display-setting.ts")).useNewChatStats };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("phone New Chat stats ignores the legacy enabled choice and persists explicit opt-in and opt-out", async () => {
  for (const legacy of [undefined, "on", "off"]) {
    const storage = new Map(legacy ? [["milagre.new-chat-stats.v1", legacy]] : []);
    const first = phone(storage);
    assert.equal(await first.store.readNewChatStats(), false);
    const useStats = first.hook();
    assert.equal(useStats()[0], false, "no enabled flash before storage resolves");
    await settle();
    assert.equal(useStats()[0], false);
    useStats()[1](true);
    assert.equal(useStats()[0], true);
    await settle();
    const restarted = phone(storage).hook();
    await settle();
    assert.equal(restarted()[0], true, "opt-in survives a new store and hook instance");
    restarted()[1](false);
    await settle();
    const disabled = phone(storage).hook();
    await settle();
    assert.equal(disabled()[0], false, "opt-out survives restart");
    assert.equal(storage.get("milagre.new-chat-stats.v1"), legacy, "legacy preference is left alone");
  }
});

test("phone New Chat stats keeps an opt-in made while its initial storage read is pending", async () => {
  let finish;
  const storage = new Map();
  const instance = phone(storage, (key) =>
    key === "milagre.new-chat-stats.v2"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(null),
  );
  const useStats = instance.hook();
  assert.equal(useStats()[0], false);
  useStats()[1](true);
  finish("off");
  await settle();
  assert.equal(useStats()[0], true);
  assert.equal(storage.get("milagre.new-chat-stats.v2"), "on");
});
