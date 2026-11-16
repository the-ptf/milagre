import { test } from "node:test";
import assert from "node:assert/strict";
import { MASCOT_COLORS, ORCHESTRATOR_DEFAULTS, type OrchestratorSnapshot, type OrchestratorTask } from "@milagre/shared/orchestrator";
import type { LiveSignal } from "./live.ts";
import { createOrchestratorStore } from "./orchestrator-store.ts";

const snapshot = (patch: Partial<OrchestratorSnapshot["settings"]> = {}, tasks: OrchestratorTask[] = []): OrchestratorSnapshot => ({
  settings: { ...ORCHESTRATOR_DEFAULTS, ...patch },
  tasks,
  memory: { notes: [], trust: {}, sources: [], importedAt: null, updatedAt: 0 },
});

function host(initial: OrchestratorSnapshot) {
  let current = initial;
  const calls: [string, unknown[]][] = [];
  const lives: { signal: (signal: LiveSignal) => void; closed: boolean }[] = [];
  const holds: (() => void)[] = [];
  const client = {
    async call<T>(method: string, args: unknown[]): Promise<T> {
      calls.push([method, args]);
      if (method === "orchestrator:read") return current as T;
      if (method === "orchestrator:settings:save") {
        await new Promise<void>((resolve) => holds.push(resolve));
        current = { ...current, settings: { ...current.settings, ...(args[0] as object) } };
        return current.settings as T;
      }
      if (method === "orchestrator:send") {
        const task = { id: "new", prompt: String(args[0]), title: "New", state: "routing", createdAt: 9 } as OrchestratorTask;
        return task as T;
      }
      if (method === "agent:fail") throw new Error("Not available from mobile");
      return null as T;
    },
    live(_path: string, options: { onSignal: (signal: LiveSignal) => void }) {
      const entry = { signal: options.onSignal, closed: false };
      lives.push(entry);
      return {
        close() {
          entry.closed = true;
        },
      };
    },
  };
  return {
    client,
    calls,
    lives,
    release: () => holds.shift()?.(),
    set: (next: OrchestratorSnapshot) => {
      current = next;
    },
  };
}
const appState = { subscribe: () => () => {} };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("it listens for the host's signal only while the Orchestrator is on", async () => {
  const mac = host(snapshot());
  const store = createOrchestratorStore(mac.client, appState);
  const release = store.acquire();
  await store.refresh();
  assert.equal(store.get().snapshot?.settings.enabled, false);
  assert.equal(mac.lives.length, 0);
  mac.set(snapshot({ enabled: true }));
  await store.refresh();
  assert.equal(mac.lives.length, 1);
  mac.set(snapshot({ enabled: true }, [{ id: "a", title: "A", createdAt: 1 } as OrchestratorTask]));
  mac.lives[0]?.signal("orchestrator");
  await settle();
  assert.deepEqual(
    store.get().snapshot?.tasks.map((task) => task.id),
    ["a"],
  );
  release();
  assert.equal(mac.lives[0]?.closed, true);
});

test("a setting shows at once and a sent task lands before the host lists it", async () => {
  const mac = host(snapshot({ enabled: true }));
  const store = createOrchestratorStore(mac.client, appState);
  await store.refresh();
  const saving = store.saveSettings({ mascotColor: MASCOT_COLORS[1] });
  assert.equal(store.get().snapshot?.settings.mascotColor, MASCOT_COLORS[1]);
  mac.release();
  await saving;
  assert.equal(store.get().snapshot?.settings.mascotColor, MASCOT_COLORS[1]);
  await store.send("fix it");
  assert.deepEqual(
    store.get().snapshot?.tasks.map((task) => task.id),
    ["new"],
  );
});

test("an older computer without the Orchestrator reads as unavailable", async () => {
  const store = createOrchestratorStore(
    {
      call: () => Promise.reject(new Error("orchestrator:read is not available from mobile")),
      live: () => ({ close() {} }),
    },
    appState,
  );
  await store.refresh();
  assert.equal(store.get().unavailable, true);
  assert.equal(store.get().snapshot, null);
});
