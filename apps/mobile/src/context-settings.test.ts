import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { Client } from "./client.ts";
import type { ContextSettings } from "@milagre/shared/context-settings";

// Load the production store with only the native event bridge and route/session imports replaced.
const nativeUrl =
  "data:text/javascript," +
  encodeURIComponent(`
  const listeners = new Set();
  export const AppState = {
    currentState: 'active',
    addEventListener(_event, listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    emit(state) { this.currentState = state; for (const listener of listeners) listener(state); },
    count: () => listeners.size,
  };
`);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/context-settings.ts")) {
      const url =
        specifier === "react-native"
          ? nativeUrl
          : specifier === "expo-router"
            ? "data:text/javascript,export const useFocusEffect = () => {}"
            : specifier === "./session"
              ? "data:text/javascript,export const useSession = () => {}"
              : specifier === "./use-rpc"
                ? new URL("./use-rpc.ts", import.meta.url).href
                : null;
      if (url) return { url, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { createContextSettingsStore, contextSettingsStore } = await import("./context-settings.ts");
const { AppState } = await import(nativeUrl);
hooks.deregister();
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  let settings = { enabled: true } as unknown as ContextSettings;
  const calls: string[] = [];
  const client = {
    call: async (method: string, args: unknown[]) => {
      calls.push(method);
      if (method === "context:settings:save") settings = { ...settings, ...(args[0] as object) };
      return structuredClone(settings);
    },
  } as unknown as Client;
  return { client, calls, store: contextSettingsStore(client) };
}

test("many subscribers share one read per client, with no timer polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { client, store, calls } = setup();
  assert.equal(contextSettingsStore(client), store);
  const releases = Array.from({ length: 12 }, () => store.subscribe(() => {}));
  await settle();
  assert.deepEqual(calls, ["context:settings:read"]);
  assert.equal(AppState.count(), 1);
  const snapshot = store.getSnapshot();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(calls.length, 1);
  await store.refresh();
  assert.equal(store.getSnapshot(), snapshot, "unchanged reads keep the external snapshot");
  const second = setup();
  const stopSecond = second.store.subscribe(() => {});
  await settle();
  assert.equal(second.calls.length, 1);
  releases.forEach((release) => release());
  stopSecond();
  assert.equal(AppState.count(), 0);
  const stop = store.subscribe(() => {});
  await settle();
  assert.equal(calls.length, 3, "first subscriber after unmount reads again");
  stop();
});

test("foreground, focus refresh and save update all subscribers without duplicate reads", async () => {
  const { store, calls } = setup();
  let changes = 0;
  const stop = store.subscribe(() => changes++);
  await settle();
  AppState.emit("background");
  await settle();
  assert.equal(calls.length, 1);
  AppState.emit("active");
  await Promise.all([store.refresh(), store.refresh()]);
  assert.equal(calls.length, 2, "focus and foreground share an in-flight read");
  AppState.emit("active");
  await settle();
  assert.equal(calls.length, 2, "repeated active events are not foreground transitions");
  await store.save({ enabled: false } as unknown as Partial<ContextSettings>);
  assert.deepEqual(calls.slice(-2), ["context:settings:save", "context:settings:read"]);
  assert.equal(changes, 2);
  assert.equal((store.getSnapshot().settings as unknown as { enabled: boolean }).enabled, false);
  stop();
  AppState.emit("background");
  AppState.emit("active");
  await settle();
  assert.equal(calls.length, 4, "unsubscribed clients do not read on foreground");
});

test("save supersedes a read started before the write", async () => {
  let resolveOld!: (value: unknown) => void;
  let reads = 0;
  const client = {
    call: async (method: string) => {
      if (method.endsWith(":save")) return;
      if (++reads === 1)
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      return { enabled: false };
    },
  } as unknown as Client;
  const store = createContextSettingsStore(client);
  const stop = store.subscribe(() => {});
  await settle();
  await store.save({});
  const saved = store.getSnapshot();
  resolveOld({ enabled: true });
  await settle();
  assert.equal(store.getSnapshot(), saved);
  assert.equal(reads, 2);
  stop();
});

test("read errors notify once, keep settings, and clear on recovery", async () => {
  let fail = false;
  const client = {
    call: async () => {
      if (fail) throw new Error("offline");
      return { enabled: true };
    },
  } as unknown as Client;
  const store = createContextSettingsStore(client);
  let changes = 0;
  const stop = store.subscribe(() => changes++);
  await settle();
  const data = store.getSnapshot().settings;
  fail = true;
  await store.refresh();
  await store.refresh();
  assert.equal(changes, 2);
  assert.equal(store.getSnapshot().error, "offline");
  assert.equal(store.getSnapshot().settings, data);
  fail = false;
  await store.refresh();
  assert.equal(changes, 3);
  assert.equal(store.getSnapshot().error, "");
  stop();
});
