import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { BotsSnapshot } from "@milagre/shared/bots";
import type { MilagreBridge } from "../electron.d.ts";

(globalThis as { window?: unknown }).window = { milagre: {} };
const { botsStore, shouldNotifyCompletion } = await import("./bots-store.ts");

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const bot = (id: string, homePath: string, threadSessionId: number) =>
  ({ id, name: id, homePath, threadSessionId, preview: "", lastAt: null, unread: false, pendingGates: 0 }) as unknown as BotsSnapshot["bots"][number];
const SNAPSHOT = {
  enabled: true,
  bots: [bot("ops", "/d/bots/ops", 1)],
  gates: [],
  grants: [],
  chats: [
    { chatKey: "/p#4", botId: "ops", title: "Fix flaky test", projectPath: "/p", status: "running", createdAt: 1 },
    { chatKey: "/p#6", botId: "ops", title: "Bump", projectPath: "/p", status: "taken-over", createdAt: 2 },
  ],
} as BotsSnapshot;

function bridge(answers: Array<boolean | Error>) {
  let changed: ((snapshot: BotsSnapshot) => void) | undefined;
  let enabledChanged: ((value: { enabled: boolean }) => void) | undefined;
  const saves: boolean[] = [];
  const reads: number[] = [];
  const fake = {
    readBotsEnabled: async () => {
      reads.push(Date.now());
      const answer = answers.shift() ?? true;
      if (answer instanceof Error) throw answer;
      return { enabled: answer };
    },
    listBots: async () => ({ ...SNAPSHOT, bots: [] }),
    saveBotsEnabled: async (enabled: boolean) => {
      saves.push(enabled);
      return { enabled };
    },
    onBotsChanged: (callback: typeof changed) => {
      changed = callback;
      return () => (changed = undefined);
    },
    onBotsEnabledChanged: (callback: typeof enabledChanged) => {
      enabledChanged = callback;
      return () => (enabledChanged = undefined);
    },
  } as unknown as MilagreBridge;
  return { fake, saves, reads, emit: (snapshot: BotsSnapshot) => changed?.(snapshot), emitEnabled: (enabled: boolean) => enabledChanged?.({ enabled }) };
}

test("reads the flag and the snapshot, and follows changes", async () => {
  const host = bridge([false]);
  const store = botsStore(host.fake);
  const stop = store.subscribe(() => {});
  await settle();
  assert.equal(store.snapshot().ready, true);
  assert.equal(store.snapshot().enabled, false);
  assert.deepEqual(store.snapshot().snapshot?.bots, []);
  host.emit(SNAPSHOT);
  assert.equal(store.snapshot().snapshot?.bots[0].id, "ops");
  assert.equal(store.snapshot().enabled, true);
  host.emitEnabled(false);
  assert.equal(store.snapshot().enabled, false);
  await store.save(true);
  assert.deepEqual(host.saves, [true]);
  assert.equal(store.snapshot().enabled, true);
  stop();
  host.emit({ ...SNAPSHOT, bots: [] });
  assert.equal(store.snapshot().snapshot?.bots[0].id, "ops", "no reader, no listener");
});

test("a read the host rejects is asked again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const host = bridge([new Error("Too many pending daemon requests"), true]);
    const store = botsStore(host.fake);
    const stop = store.subscribe(() => {});
    await settle();
    assert.equal(store.snapshot().error, "Could not read your bots.");
    mock.timers.tick(10_000);
    await settle();
    assert.equal(host.reads.length, 2);
    assert.deepEqual({ enabled: store.snapshot().enabled, error: store.snapshot().error }, { enabled: true, error: null });
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("a bridge without the bot methods is a failed read, not a throw", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const store = botsStore({} as MilagreBridge);
    let stop = () => {};
    assert.doesNotThrow(() => (stop = store.subscribe(() => {})));
    await settle();
    assert.deepEqual({ ready: store.snapshot().ready, enabled: store.snapshot().enabled }, { ready: true, enabled: false });
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("completions of quiet chats are not notified", () => {
  assert.equal(shouldNotifyCompletion(SNAPSHOT, "/d/bots/ops#1"), false);
  assert.equal(shouldNotifyCompletion(SNAPSHOT, "/p#4"), false);
  assert.equal(shouldNotifyCompletion(SNAPSHOT, "/p#6"), true, "a Chat the user took over is theirs again");
  assert.equal(shouldNotifyCompletion(SNAPSHOT, "/p#5"), true);
  assert.equal(shouldNotifyCompletion(null, "/p#5"), true);
});
