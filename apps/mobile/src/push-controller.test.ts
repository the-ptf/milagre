import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPushController, notificationTarget, shouldPresentNotification, SHEETS_OVER_CHAT, SHEETS_OVER_PAGES, viewedChat } from "./push-controller.ts";
import { createPushStore } from "./push-store.ts";
import type { SavedHost } from "./hosts-store.ts";
const deviceId = "b6e2df4b-972b-4e7b-bc65-6cda0a173798";
const host: SavedHost = { id: "https://mac.example", address: "https://mac.example", name: "Mac", token: "a".repeat(64), lastUsed: 0 };
const data = { kind: "milagre-chat", hostId: host.id, projectPath: "/project", sessionId: 1, eventId: "event-1" };
function fixture(extra: Record<string, unknown> = {}) {
  let stored: string | null = null;
  const store = createPushStore(
    {
      getItemAsync: async () => stored,
      setItemAsync: async (_key, value) => {
        stored = value;
      },
    },
    () => deviceId,
  );
  const calls: { host: SavedHost; method: string; args: unknown[] }[] = [];
  const native = { available: () => "", permission: async () => true, requestPermission: async () => true, token: async () => "ExpoPushToken[one]" };
  const controller = createPushController({
    store,
    hosts: async () => [host],
    native,
    call: async (host, method, args) => {
      calls.push({ host, method, args });
    },
    ...extra,
  });
  return { store, calls, native, controller };
}

test("opt-in obtains permission/token and registers the remembered computers with preferences", async () => {
  const { controller, calls, store } = fixture();
  await controller.enable();
  assert.equal((await store.read()).enabled, true);
  assert.deepEqual(calls[0], {
    host,
    method: "push:register",
    args: [{ deviceId, token: "ExpoPushToken[one]", hostId: host.id, notifyWhenWaiting: true, notifyOnCompletion: true, chime: "system", schedule: null }],
  });
  await controller.preferences({ notifyOnCompletion: false });
  assert.equal((calls.at(-1)!.args[0] as { notifyOnCompletion: boolean }).notifyOnCompletion, false);
  await controller.preferences({ chime: "miracle" });
  assert.equal((calls.at(-1)!.args[0] as { chime: string }).chime, "miracle");
});

test("denied permission never registers or enables notifications", async () => {
  const { controller, calls, store } = fixture({
    native: {
      available: () => "",
      permission: async () => false,
      requestPermission: async () => false,
      token: async () => {
        throw new Error("should not be called");
      },
    },
  });
  await assert.rejects(controller.enable(), /Settings/);
  assert.equal((await store.read()).enabled, false);
  assert.deepEqual(calls, []);
});

test("offline forget remains durable and retries before re-registration", async () => {
  let online = true;
  const methods: string[] = [];
  const { controller, store } = fixture({
    call: async (_host: SavedHost, method: string) => {
      methods.push(method);
      if (!online) throw new Error("offline");
    },
  });
  await controller.enable();
  online = false;
  await controller.forget(host);
  assert.equal((await store.read()).pending.length, 1);
  online = true;
  await controller.refresh();
  assert.equal((await store.read()).pending.length, 0);
  assert.equal(methods.at(-1), "push:unregister");
});

test("disable wins over a permission/token request that completes later", async () => {
  let resolve!: (token: string) => void;
  const token = new Promise<string>((done) => {
    resolve = done;
  });
  const { controller, store, calls } = fixture({
    native: { available: () => "", permission: async () => true, requestPermission: async () => true, token: () => token },
  });
  const enabling = controller.enable();
  await new Promise((done) => setTimeout(done, 1));
  const disabling = controller.disable();
  resolve("ExpoPushToken[late]");
  await Promise.all([enabling, disabling]);
  assert.equal((await store.read()).enabled, false);
  assert.deepEqual(calls, []);
});

test("refresh rotates tokens without requesting permission and revocation unregisters", async () => {
  const { controller, store, native, calls } = fixture();
  await controller.enable();
  native.token = async () => "ExpoPushToken[new]";
  native.requestPermission = async () => {
    throw new Error("Never prompt on refresh");
  };
  await controller.refresh();
  assert.equal((calls.at(-1)!.args[0] as { token: string }).token, "ExpoPushToken[new]");
  native.permission = async () => false;
  await controller.refresh();
  assert.equal((await store.read()).enabled, false);
  assert.equal(calls.at(-1)!.method, "push:unregister");
});

test("focus is reported only to the selected registered computer and clears on background", async () => {
  const { controller, calls } = fixture();
  await controller.enable();
  await controller.focus({ hostId: host.id, chatId: "/project#1" });
  assert.deepEqual(calls.at(-1)!.args, [{ deviceId, chatId: "/project#1" }]);
  await controller.focus(null);
  assert.deepEqual(calls.at(-1)!.args, [{ deviceId, chatId: null }]);
});

test("targets accept only remembered hosts, absolute Projects and positive Chat IDs", () => {
  assert.deepEqual(notificationTarget(data, [host]), { host, projectPath: "/project", sessionId: 1, eventId: "event-1" });
  for (const bad of [
    { ...data, hostId: "https://unknown.example" },
    { ...data, projectPath: "../project" },
    { ...data, sessionId: -1 },
    { ...data, sessionId: "1" },
    { ...data, kind: "other" },
  ])
    assert.equal(notificationTarget(bad, [host]), null);
  assert.equal(notificationTarget(data, []), null);
});

test("foreground alerts are suppressed for the current Chat only", () => {
  assert.equal(shouldPresentNotification(data, { hostId: host.id, chatId: "/project#1" }), false);
  assert.equal(shouldPresentNotification(data, { hostId: host.id, chatId: "/project#2" }), true);
  assert.equal(shouldPresentNotification(data, null), true);
  assert.equal(shouldPresentNotification(data, { hostId: "https://other.example", chatId: "/project#1" }), true);
});

test("a sheet over the Chat keeps it viewed; other pages and another computer do not", () => {
  const chat = { hostId: host.id, chatId: "/project#1" };
  assert.deepEqual(viewedChat("/chat", chat, null, host.id), chat);
  assert.deepEqual(viewedChat("/permission-sheet", null, chat, host.id), chat);
  assert.deepEqual(viewedChat("/viewer", null, chat, host.id), chat);
  assert.deepEqual(viewedChat("/settings", null, chat, host.id), chat);
  assert.deepEqual(viewedChat("/general", null, chat, host.id), chat);
  assert.equal(viewedChat("/permission-sheet", null, chat, "https://other.example"), null);
  assert.equal(viewedChat("/terminal-sheet", null, chat, host.id), null);
  assert.equal(viewedChat("/changes", null, chat, host.id), null);
  assert.equal(viewedChat("/", null, chat, host.id), null);
});

test("the sheets that keep a Chat viewed are the layout's sheets and transparent modals", () => {
  const layout = readFileSync(new URL("./app/_layout.tsx", import.meta.url), "utf8");
  const overlays = [...layout.matchAll(/name="([\w-]+)"\s*options=\{\{\s*(?:\.\.\.sheet|presentation: "transparentModal")/g)].map((match) => match[1]);
  assert.ok(overlays.includes("permission-sheet"));
  // Every sheet either opens over the Chat, keeping it viewed, or over a full-screen page that already hides it.
  assert.deepEqual([...SHEETS_OVER_CHAT, ...SHEETS_OVER_PAGES].sort(), overlays.sort());
  assert.equal(viewedChat("/design-share-sheet", null, { hostId: host.id, chatId: "/p#1" }, host.id), null);
});

test("Forget persists removal without waiting for a suspended unregister", async () => {
  let release!: () => void;
  const network = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { controller, store } = fixture({
    call: async (_host: SavedHost, method: string) => {
      if (method === "push:unregister") await network;
    },
  });
  await controller.enable();
  try {
    await Promise.race([controller.forget(host), new Promise((_, reject) => setTimeout(() => reject(new Error("Forget waited for network")), 100))]);
    const [pending] = (await store.read()).pending;
    assert.ok(pending);
    assert.equal(pending.id, host.id);
  } finally {
    release();
  }
});

test("a new pairing credential removes an old tombstone before registration", async () => {
  const repaired = { ...host, token: "b".repeat(64), lastUsed: 1 };
  const calls: string[] = [];
  const { controller, store } = fixture({
    hosts: async () => [repaired],
    call: async (target: SavedHost, method: string) => {
      calls.push(method);
      if (target.token === host.token) throw new Error("401");
    },
  });
  await store.registered(host);
  await store.disable();
  await controller.enable();
  assert.deepEqual(calls, ["push:unregister", "push:register"]);
  assert.equal((await store.read()).pending.length, 0);
});

test("restart finishes local Forget before a suspended network cleanup and rejects its taps", async () => {
  let saved = [host];
  const { controller, store, native } = fixture();
  await controller.enable();
  await controller.forget(host);
  // Simulate a process exit after the durable tombstone, before hosts-store removal.
  let release!: () => void;
  const network = new Promise<void>((resolve) => {
    release = resolve;
  });
  const methods: string[] = [];
  const restarted = createPushController({
    store,
    native,
    hosts: async () => saved,
    forgetHost: async (removed) => {
      saved = saved.filter((item) => item.id !== removed.id);
    },
    call: async (_host, method) => {
      methods.push(method);
      await network;
    },
  });
  const refresh = restarted.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notificationTarget(data, saved), null);
  assert.equal(saved.length, 0);
  assert.deepEqual(methods, ["push:unregister"]);
  release();
  await refresh;
  assert.deepEqual(methods, ["push:unregister"]);
});

test("phone schedules reach capable computers and are removed when anytime is selected", async () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const { controller, store } = fixture({
    call: async (_host: SavedHost, method: string, args: unknown[]) => {
      calls.push({ method, args });
      return { capabilities: ["mobile-push-schedule-v1"] };
    },
  });
  await controller.enable();
  const schedule = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", timeZone: "America/Toronto" };
  await controller.preferences({ schedule });
  assert.deepEqual((await store.read()).schedule, schedule);
  assert.equal(calls.at(-2)?.method, "daemon:status");
  assert.deepEqual((calls.at(-1)!.args[0] as { schedule: unknown }).schedule, schedule);
  await controller.preferences({ schedule: null });
  assert.equal((calls.at(-1)!.args[0] as { schedule: unknown }).schedule, null);
});

test("an older computer is unregistered before it can ignore quiet hours", async () => {
  const errors: string[] = [];
  const { controller, calls } = fixture({ onError: (message: string) => errors.push(message) });
  await controller.enable();
  calls.length = 0;
  await controller.preferences({ schedule: { days: [1], start: "09:00", end: "17:00", timeZone: "UTC" } });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["daemon:status", "push:unregister"],
  );
  assert.match(errors[0]!, /Update Milagre on Mac/);
});
