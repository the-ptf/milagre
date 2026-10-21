import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageSnapshot } from "@milagre/shared/model";
import { createUsageState } from "./usage-state.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const snapshot = (percent = 32): UsageSnapshot => ({
  providers: [
    {
      provider: "claude",
      status: "ok",
      updatedAt: new Date(NOW).toISOString(),
      windows: [
        { id: "session", label: "Session", shortLabel: "5h", usedPercent: percent, resetsAt: new Date(NOW + 60000).toISOString() },
        { id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 45, resetsAt: new Date(NOW + 86400000).toISOString() },
      ],
    },
  ],
});
function providerOf(value: UsageSnapshot | null | undefined) {
  assert.ok(value);
  const [provider] = value.providers;
  assert.ok(provider);
  return provider;
}
function sessionPercent(value: UsageSnapshot | null | undefined) {
  const [window] = providerOf(value).windows;
  assert.ok(window);
  return window.usedPercent;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function client(read: (method: string) => Promise<UsageSnapshot>) {
  return { call: <T>(method: string) => read(method) as Promise<T> };
}

test("saved usage appears during a refresh and a late cache never replaces fresh data", async () => {
  const cached = deferred<UsageSnapshot>(),
    fresh = deferred<UsageSnapshot>();
  const state = createUsageState(
    client((method) => (method === "usage:cached" ? cached.promise : fresh.promise)),
    () => NOW,
  );
  const loading = state.loadCached(),
    refreshing = state.refresh();
  cached.resolve(snapshot());
  await loading;
  assert.equal(sessionPercent(state.get().snapshot), 32);
  assert.equal(state.get().loading, true);
  fresh.resolve(snapshot(40));
  await refreshing;
  assert.equal(sessionPercent(state.get().snapshot), 40);
  const late = deferred<UsageSnapshot>();
  const next = createUsageState(
    client((method) => (method === "usage:cached" ? late.promise : Promise.resolve(snapshot(50)))),
    () => NOW,
  );
  const seeding = next.loadCached();
  await next.refresh();
  late.resolve(snapshot());
  await seeding;
  assert.equal(sessionPercent(next.get().snapshot), 50);
});

test("refresh requests share one read and stale checks respect the last attempt", async () => {
  let reads = 0,
    now = NOW;
  const fresh = deferred<UsageSnapshot>();
  const state = createUsageState(
    client(async () => {
      reads++;
      return fresh.promise;
    }),
    () => now,
  );
  const first = state.refresh();
  assert.equal(state.refresh(), first);
  assert.equal(reads, 1);
  fresh.resolve(snapshot());
  await first;
  await state.refreshIfStale(60000);
  assert.equal(reads, 1);
  now += 60001;
  await state.refreshIfStale(60000);
  assert.equal(reads, 2);
});

test("provider failures preserve valid cached windows and their original timestamp", async () => {
  let now = NOW;
  const failed: UsageSnapshot = {
    providers: [{ provider: "claude", status: "error", windows: [], updatedAt: new Date(NOW + 120000).toISOString(), message: "Rate limited." }],
  };
  const state = createUsageState(
    client((method) => Promise.resolve(method === "usage:cached" ? snapshot() : failed)),
    () => now,
  );
  await state.loadCached();
  now += 120000;
  await state.refresh();
  const provider = providerOf(state.get().snapshot);
  assert.equal(provider.status, "error");
  assert.equal(provider.updatedAt, providerOf(snapshot()).updatedAt);
  assert.deepEqual(
    provider.windows.map((window) => window.id),
    ["weekly"],
  );
  assert.equal(provider.message, "Rate limited.");
});

test("connection failures leave cached usage visible and can recover on retry", async () => {
  let fail = true;
  const state = createUsageState(
    client(async (method) => {
      if (method === "usage:cached") return snapshot();
      if (fail) throw new Error("Computer offline.");
      return snapshot(60);
    }),
    () => NOW,
  );
  await state.loadCached();
  await state.refresh();
  assert.equal(state.get().error, "Computer offline.");
  assert.equal(sessionPercent(state.get().snapshot), 32);
  fail = false;
  await state.refresh();
  assert.equal(state.get().error, "");
  assert.equal(sessionPercent(state.get().snapshot), 60);
});

test("a late cache can restore valid last-known limits after a provider error", async () => {
  const cached = deferred<UsageSnapshot>();
  const failed: UsageSnapshot = { providers: [{ ...providerOf(snapshot()), status: "error", windows: [], message: "Rate limited." }] };
  const state = createUsageState(
    client((method) => (method === "usage:cached" ? cached.promise : Promise.resolve(failed))),
    () => NOW,
  );
  const loading = state.loadCached();
  await state.refresh();
  cached.resolve(snapshot());
  await loading;
  assert.equal(providerOf(state.get().snapshot).status, "error");
  assert.equal(sessionPercent(state.get().snapshot), 32);
});

test("transport failure drops expired limits rather than displaying them as current", async () => {
  let now = NOW;
  const state = createUsageState(
    client(async (method) => {
      if (method === "usage:cached") return snapshot();
      throw new Error("Offline.");
    }),
    () => now,
  );
  assert.equal(state.get().loading, true, "first render must show checking, not an empty account");
  await state.loadCached();
  now += 120000;
  await state.refresh();
  assert.deepEqual(
    providerOf(state.get().snapshot).windows.map((window) => window.id),
    ["weekly"],
  );
});

test("usage state for another computer starts empty and old requests cannot publish after unsubscribe", async () => {
  const pending = deferred<UsageSnapshot>();
  const old = createUsageState(
    client(() => pending.promise),
    () => NOW,
  );
  let updates = 0;
  const unsubscribe = old.subscribe(() => {
    updates++;
  });
  const refreshing = old.refresh();
  unsubscribe();
  const before = updates;
  const next = createUsageState(
    client(async () => snapshot(70)),
    () => NOW,
  );
  assert.equal(next.get().snapshot, null);
  pending.resolve(snapshot());
  await refreshing;
  assert.equal(updates, before);
  await next.refresh();
  assert.equal(sessionPercent(next.get().snapshot), 70);
});

test("usage reads and cached usage stay isolated to the selected scope", async () => {
  const calls: [string, unknown[] | undefined][] = [];
  const rpc = {
    call: async <T>(method: string, args?: unknown[]) => {
      calls.push([method, args]);
      return snapshot() as T;
    },
  };
  const project = createUsageState(rpc, () => NOW, "/project");
  const link = createUsageState(rpc, () => NOW, "link:two");
  await project.loadCached();
  await project.refresh();
  assert.equal(link.get().snapshot, null);
  await link.refresh();
  assert.deepEqual(calls, [
    ["usage:cached", ["/project"]],
    ["usage:read", ["/project"]],
    ["usage:read", ["link:two"]],
  ]);
});

test("usage pushes reload saved limits without another provider read and ignore a late cache", async () => {
  let saved = snapshot(32);
  let reads = 0;
  const late = deferred<UsageSnapshot>();
  let delayed = false;
  const state = createUsageState(
    client(async (method) => {
      if (method === "usage:read") {
        reads++;
        return snapshot(90);
      }
      return delayed ? late.promise : saved;
    }),
    () => NOW,
  );
  await state.loadCached();
  saved = snapshot(66);
  await state.loadCached(true);
  assert.equal(sessionPercent(state.get().snapshot), 66);
  assert.equal(reads, 0);
  delayed = true;
  const pending = state.loadCached(true);
  await state.refresh();
  late.resolve(snapshot(70));
  await pending;
  assert.equal(sessionPercent(state.get().snapshot), 90);
});
