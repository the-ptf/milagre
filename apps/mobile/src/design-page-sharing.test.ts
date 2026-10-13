import assert from "node:assert/strict";
import test from "node:test";
import { createDesignPageSharing } from "./design-page-sharing.ts";

const snapshot = {
  id: "snapshot-1",
  title: "Designs",
  url: "https://share.milagre.cloud/s/snapshot-1",
  createdAt: 100,
  designCount: 3,
};
const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const caller = (call: (method: string, args: unknown[]) => Promise<unknown>) => ({
  call: async <T>(method: string, args: unknown[]) => (method === "artifact:sharing-status" ? { available: true } : await call(method, args)) as T,
});

test("opening page sharing only reads history; explicit publish acknowledges whole-page publication", async () => {
  const calls: unknown[] = [];
  const store = createDesignPageSharing(
    caller(async (method, args) => {
      calls.push([method, args]);
      return method === "artifact:page-shares" ? [] : snapshot;
    }),
    "project#chat",
  );
  await store.refresh();
  await store.checkAvailability();
  assert.deepEqual(calls, [["artifact:page-shares", [{ chatId: "project#chat" }]]]);
  await store.publish("  Designs  ");
  assert.deepEqual(calls[1], ["artifact:share-page", [{ chatId: "project#chat", title: "Designs", acknowledgePublic: true }]]);
  assert.deepEqual(store.getSnapshot().shares, [snapshot]);
});

test("double taps send one publication and rejected upload preserves existing links", async () => {
  const pending = deferred();
  let publications = 0;
  const store = createDesignPageSharing(
    caller(async (method) => {
      if (method === "artifact:page-shares") return [snapshot];
      publications++;
      return pending.promise;
    }),
    "a",
  );
  await store.refresh();
  await store.checkAvailability();
  const first = store.publish("Designs");
  await store.publish("Again");
  assert.equal(publications, 1);
  pending.reject(new Error("Upload unavailable"));
  await first;
  assert.equal(store.getSnapshot().error, "Upload unavailable");
  assert.deepEqual(store.getSnapshot().shares, [snapshot]);
  assert.equal(store.getSnapshot().busy, null);
});

test("stale history cannot overwrite a newly published snapshot", async () => {
  const pending = deferred();
  let reads = 0;
  const store = createDesignPageSharing(
    caller(async (method) => (method === "artifact:page-shares" ? (reads++ ? pending.promise : []) : snapshot)),
    "a",
  );
  await store.refresh();
  await store.checkAvailability();
  const oldRead = store.refresh();
  await store.publish("Designs");
  pending.resolve([]);
  await oldRead;
  assert.deepEqual(store.getSnapshot().shares, [snapshot]);
});

test("closing or changing Chats drops late results and blocks subsequent writes", async () => {
  const pending = deferred();
  let calls = 0;
  const store = createDesignPageSharing(
    caller(async (method) => {
      if (method === "artifact:page-shares") return [];
      calls++;
      return pending.promise;
    }),
    "old-chat",
  );
  await store.refresh();
  await store.checkAvailability();
  let notifications = 0;
  store.subscribe(() => notifications++);
  const publishing = store.publish("Designs");
  store.dispose();
  pending.resolve(snapshot);
  await publishing;
  await store.publish("Again");
  await store.revoke(snapshot.id);
  assert.equal(calls, 1);
  assert.equal(notifications, 1);
  assert.deepEqual(store.getSnapshot().shares, []);
});

test("revocation marks only the hosted link, keeps other snapshots and reports failures", async () => {
  let fail = true;
  const calls: unknown[] = [];
  const store = createDesignPageSharing(
    caller(async (method, args) => {
      calls.push([method, args]);
      if (method === "artifact:page-shares") return [snapshot, { ...snapshot, id: "another" }];
      if (fail) throw new Error("Disconnected");
    }),
    "a",
  );
  await store.refresh();
  await store.checkAvailability();
  await store.revoke(snapshot.id);
  assert.equal(store.getSnapshot().error, "Disconnected");
  assert.equal(store.getSnapshot().shares[0]!.revoked, undefined);
  fail = false;
  await store.revoke(snapshot.id);
  assert.equal(store.getSnapshot().shares[0]!.revoked, true);
  assert.equal(store.getSnapshot().shares[1]!.revoked, undefined);
  assert.deepEqual(calls.at(-1), ["artifact:revoke-page-share", [{ chatId: "a", id: snapshot.id }]]);
});

test("publish waits for the first successful history read, including after read errors", async () => {
  let ready = false;
  let publications = 0;
  const store = createDesignPageSharing(
    caller(async (method) => {
      if (method === "artifact:page-shares") {
        if (!ready) throw new Error("Offline");
        return [];
      }
      publications++;
      return snapshot;
    }),
    "a",
  );
  await store.publish("Designs");
  await store.refresh();
  await store.checkAvailability();
  await store.publish("Designs");
  assert.equal(publications, 0);
  ready = true;
  await store.refresh();
  await store.checkAvailability();
  await store.publish("Designs");
  assert.equal(publications, 1);
});

test("an uncertain upload refreshes history to expose its revocable pending link", async () => {
  let attempted = false;
  const store = createDesignPageSharing(
    caller(async (method) => {
      if (method === "artifact:page-shares") return attempted ? [{ ...snapshot, pending: true }] : [];
      attempted = true;
      throw new Error("Upload acknowledgement lost");
    }),
    "a",
  );
  await store.refresh();
  await store.checkAvailability();
  await store.publish("Designs");
  assert.equal(store.getSnapshot().shares[0]!.pending, true);
  assert.equal(store.getSnapshot().error, "Upload acknowledgement lost");
});

test("unavailable service keeps history visible, blocks publish, and retry enables it", async () => {
  let available = false;
  const calls: string[] = [];
  const store = createDesignPageSharing(
    {
      call: async <T>(method: string) => {
        calls.push(method);
        return (method === "artifact:sharing-status" ? { available, reason: "Not deployed" } : method === "artifact:page-shares" ? [snapshot] : snapshot) as T;
      },
    },
    "chat",
  );
  await store.refresh();
  await store.checkAvailability();
  await store.publish("Designs");
  assert.equal(store.getSnapshot().availability?.reason, "Not deployed");
  assert.deepEqual(store.getSnapshot().shares, [snapshot]);
  assert.equal(calls.includes("artifact:share-page"), false);
  available = true;
  await store.checkAvailability();
  await store.publish("Designs");
  assert.equal(calls.includes("artifact:share-page"), true);
});

test("owner history can revoke an orphaned page without any Chat or cloud status call", async () => {
  const calls: unknown[] = [];
  const store = createDesignPageSharing(
    caller(async (method, args) => {
      calls.push([method, args]);
      return method === "artifact:all-page-shares" ? [snapshot] : undefined;
    }),
  );
  await store.refresh();
  await store.checkAvailability();
  await store.publish("No Chat");
  await store.revoke(snapshot.id);
  assert.deepEqual(calls, [
    ["artifact:all-page-shares", []],
    ["artifact:revoke-saved-page-share", [{ id: snapshot.id }]],
  ]);
  assert.equal(store.getSnapshot().shares[0]?.revoked, true);
});

test("history stays readable when availability check fails, and closing drops a late check", async () => {
  const pending = deferred();
  const store = createDesignPageSharing(
    {
      call: async <T>(method: string) => (method === "artifact:sharing-status" ? await pending.promise : [snapshot]) as T,
    },
    "chat",
  );
  await store.refresh();
  const checking = store.checkAvailability();
  pending.reject(new Error("Disconnected"));
  await checking;
  assert.equal(store.getSnapshot().availability?.available, false);
  assert.deepEqual(store.getSnapshot().shares, [snapshot]);
  store.dispose();
  await store.publish("Blocked");
});

test("artifact snapshot requests keep their kind separate from designs", async () => {
  const calls: unknown[] = [];
  const store = createDesignPageSharing(
    {
      call: async <T>(method: string, args: unknown[]) => {
        calls.push([method, args]);
        return (method === "artifact:sharing-status" ? { available: true } : method === "artifact:page-shares" ? [] : { ...snapshot, kind: "artifacts" }) as T;
      },
    },
    "project#chat",
    "artifacts",
  );
  await store.refresh();
  await store.checkAvailability();
  await store.publish("Explanation");
  await store.revoke(snapshot.id);
  assert.deepEqual(calls, [
    ["artifact:page-shares", [{ chatId: "project#chat", kind: "artifacts" }]],
    ["artifact:sharing-status", [{ kind: "artifacts" }]],
    [
      "artifact:share-page",
      [
        {
          chatId: "project#chat",
          kind: "artifacts",
          title: "Explanation",
          acknowledgePublic: true,
        },
      ],
    ],
    ["artifact:revoke-page-share", [{ chatId: "project#chat", id: snapshot.id, kind: "artifacts" }]],
  ]);
});
