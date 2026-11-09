const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function adapter({ expoGo = false, device = true, os = "ios", initial = null, permissions = { granted: true }, request = { granted: true } } = {}) {
  const calls = [];
  let stored = null;
  let tapped, rotated, handler;
  const api = {
    DEFAULT_ACTION_IDENTIFIER: "default",
    AndroidImportance: { HIGH: 4 },
    getPermissionsAsync: async () => permissions,
    requestPermissionsAsync: async () => {
      calls.push("permission");
      return request;
    },
    setNotificationChannelAsync: async (id, options) => calls.push(`channel ${id} ${options.sound}`),
    getExpoPushTokenAsync: async (options) => {
      calls.push(options);
      return { data: "ExpoPushToken[test]" };
    },
    getLastNotificationResponse: () => initial,
    clearLastNotificationResponse: () => calls.push("clear"),
    setNotificationHandler: (value) => {
      handler = value;
    },
    addNotificationResponseReceivedListener: (callback) => {
      tapped = callback;
      return { remove: () => calls.push("remove-taps") };
    },
    addPushTokenListener: (callback) => {
      rotated = callback;
      return { remove: () => calls.push("remove-tokens") };
    },
  };
  const modules = {
    "expo-constants": {
      __esModule: true,
      default: { executionEnvironment: expoGo ? "storeClient" : "standalone", expoConfig: { extra: { eas: { projectId: "project-id" } } } },
      ExecutionEnvironment: { StoreClient: "storeClient" },
    },
    "expo-device": { isDevice: device },
    "expo-crypto": { randomUUID: () => "device-id" },
    "expo-secure-store": {
      getItemAsync: async () => stored,
      setItemAsync: async (_key, value) => {
        stored = value;
      },
    },
    "react-native": { Platform: { OS: os } },
    "./push-store": require("../apps/mobile/src/push-store.ts"),
    "./push-controller": require("../apps/mobile/src/push-controller.ts"),
    "@milagre/shared/notification-schedule": require("@milagre/shared/notification-schedule"),
    "@milagre/shared/notification-chimes": require("@milagre/shared/notification-chimes"),
    "expo-notifications": api,
  };
  const source = fs.readFileSync(require.resolve("../apps/mobile/src/push-native.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => {
      assert.ok(id in modules, id);
      return modules[id];
    },
  });
  return { store: exports.pushStore, native: exports.pushNative, calls, tap: (value) => tapped(value), rotate: () => rotated(), handler: () => handler };
}

test("native adapter consumes a cold-start response, running taps and token rotation", async () => {
  const initial = { actionIdentifier: "default", notification: { request: { content: { data: { initial: true } } } } };
  const { native, calls, tap, rotate } = adapter({ initial });
  const targets = [];
  let rotations = 0;
  const stop = await native.listen(
    () => null,
    (data) => targets.push(data),
    () => rotations++,
  );
  assert.deepEqual(targets, [{ initial: true }]);
  tap({ actionIdentifier: "default", notification: { request: { content: { data: { tapped: true } } } } });
  rotate();
  assert.deepEqual(targets, [{ initial: true }, { tapped: true }]);
  assert.equal(rotations, 1);
  assert.equal(calls.filter((call) => call === "clear").length, 2);
  stop();
  assert.ok(calls.includes("remove-taps") && calls.includes("remove-tokens"));
});

test("Android prepares the notification channels before permission and uses the existing EAS project", async () => {
  const { native, calls } = adapter({ os: "android", permissions: { granted: false } });
  assert.equal(await native.requestPermission(), true);
  // One channel per chime: a channel's sound can't change once created.
  assert.deepEqual(calls.slice(0, 9), [
    "channel chats default",
    "channel chats-miracle chime_miracle.wav",
    "channel chats-faaah chime_faaah.wav",
    "channel chats-bombastic_side_eye chime_bombastic_side_eye.wav",
    "channel chats-vine_boom chime_vine_boom.wav",
    "channel chats-metal_pipe chime_metal_pipe.wav",
    "channel chats-bruh chime_bruh.wav",
    "channel chats-emotional_damage chime_emotional_damage.wav",
    "permission",
  ]);
  assert.equal(await native.token(), "ExpoPushToken[test]");
  assert.equal(calls.at(-1).projectId, "project-id");
});

test("provisional iOS authorization allows notifications without another permission prompt", async () => {
  const { native, calls } = adapter({ permissions: { granted: false, ios: { status: 3 } } });
  assert.equal(await native.permission(), true);
  assert.equal(await native.requestPermission(), true);
  assert.deepEqual(calls, []);
});

test("Expo Go skips native listeners and unavailable runtimes explain how to enable push", async () => {
  const expo = adapter({ expoGo: true });
  assert.match(expo.native.available(), /Install/);
  const stop = await expo.native.listen(
    () => null,
    () => assert.fail(),
    () => assert.fail(),
  );
  stop();
  assert.deepEqual(expo.calls, []);
  assert.match(adapter({ device: false }).native.available(), /simulator/);
});

test("the foreground phone handler silences pushes arriving outside its current schedule", async () => {
  const { native, store, handler } = adapter();
  await native.listen(
    () => null,
    () => {},
    () => {},
  );
  const notice = { request: { content: { data: {} } } };
  assert.equal((await handler().handleNotification(notice)).shouldShowBanner, true);
  await store.update({ schedule: { days: [(new Date().getUTCDay() + 1) % 7], start: "09:00", end: "17:00", timeZone: "UTC" } });
  const result = await handler().handleNotification(notice);
  assert.equal(result.shouldShowBanner, false);
  assert.equal(result.shouldPlaySound, false);
});
