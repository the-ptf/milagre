import assert from "node:assert/strict";
import test from "node:test";
import { createOutbox, canCancelOutbox } from "./outbox.mjs";

const input = (id, patch = {}) => ({
  id,
  computerId: "studio",
  computerName: "Studio",
  owner: "/p",
  conversation: "chat:4",
  request: { sessionId: 4, body: id, images: [], files: [] },
  attachments: [],
  ...patch,
});
function disk(initial = null) {
  let saved = initial;
  return {
    read: async () => structuredClone(saved),
    write: async (next) => {
      saved = structuredClone(next);
    },
    saved: () => structuredClone(saved),
  };
}
const lost = () => Object.assign(new Error("Reply lost"), { retry: "unknown" });

test("enqueue is acknowledged only after persistence; failure keeps the queue unchanged", async () => {
  const storage = disk();
  const box = createOutbox({ storage, available: () => false, deliver: async () => assert.fail() });
  await box.enqueue(input("one", { attachments: [{ name: "a.txt", base64: "YWJj" }] }));
  assert.equal(storage.saved().items[0].attachments[0].base64, "YWJj");
  storage.write = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(box.enqueue(input("two")), /disk full/);
  assert.deepEqual(
    box.getSnapshot().items.map((item) => item.id),
    ["one"],
  );
  assert.match(box.getSnapshot().error, /Could not save/);
});

test("offline messages survive restart and deliver in order, without blocking another computer", async () => {
  const storage = disk();
  const first = createOutbox({ storage, available: () => false, deliver: async () => assert.fail() });
  await first.enqueue(input("one"));
  await first.enqueue(input("two"));
  await first.enqueue(input("other", { computerId: "other" }));
  const sent = [];
  let online = false;
  const box = createOutbox({
    storage,
    available: (item) => online || item.computerId === "other",
    deliver: async (item) => {
      sent.push(item.id);
      return { sessionId: 4 };
    },
  });
  await box.flush();
  assert.deepEqual(sent, ["other"]);
  online = true;
  await Promise.all([box.flush(), box.flush()]);
  assert.deepEqual(sent, ["other", "one"]);
  await box.flush();
  assert.deepEqual(sent, ["other", "one", "two"]);
  assert.ok(box.getSnapshot().items.every((item) => item.status === "sent"));
});

test("lost acknowledgement and restart retain the message id for receipt reconciliation", async () => {
  const storage = disk();
  const receipts = new Set();
  let turns = 0;
  const deliver = async (item, update) => {
    if (receipts.has(item.id)) return { sessionId: 4 };
    await update({ phase: "dispatching" });
    receipts.add(item.id);
    turns++;
    throw lost();
  };
  const box = createOutbox({ storage, available: () => true, deliver });
  await box.enqueue(input("once"));
  await box.flush();
  assert.equal(box.getSnapshot().items[0].status, "queued");
  assert.equal(canCancelOutbox(box.getSnapshot().items[0]), false);
  await assert.rejects(box.remove("once"), /Delivery may already/);
  const restored = createOutbox({ storage, available: () => true, deliver });
  await restored.flush();
  assert.equal(turns, 1);
  assert.equal(restored.getSnapshot().items[0].status, "sent");
});

test("cancelled messages do not return after restart; cancellation cannot race an active send", async () => {
  const storage = disk();
  let release;
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const box = createOutbox({
    storage,
    available: () => true,
    deliver: () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  });
  await box.enqueue(input("cancel"));
  await box.remove("cancel");
  assert.deepEqual(storage.saved().items, []);
  await box.enqueue(input("active"));
  const flushing = box.flush();
  await entered;
  await assert.rejects(box.remove("active"), /Delivery may already/);
  release({ sessionId: 4 });
  await flushing;
  await box.remove("active");
  const restored = createOutbox({ storage, available: () => true, deliver: async () => assert.fail() });
  await restored.flush();
  assert.deepEqual(restored.getSnapshot().items, []);
});

test("uncertain Worktree creation never replays, and can recover to an explicitly selected Chat", async () => {
  const storage = disk();
  let attempts = 0;
  const box = createOutbox({
    storage,
    available: () => true,
    deliver: async (item, update) => {
      attempts++;
      if (item.request.sessionId === 9) return { sessionId: 9 };
      await update({ phase: "creating" });
      throw lost();
    },
  });
  await box.enqueue(
    input("create", { createWorktree: { projectPath: "/p", baseBranch: "main" }, request: { sessionId: null, body: "create", images: [], files: [] } }),
  );
  await box.flush();
  await box.flush();
  assert.equal(attempts, 1);
  assert.equal(box.getSnapshot().items[0].status, "failed");
  await assert.rejects(box.retry("create"), /may have finished/);
  await box.recover("create", { sessionId: 9, worktreeId: 8 });
  assert.equal(box.getSnapshot().items[0].status, "sent");
  assert.equal(attempts, 2);
});

test("restart during creation pauses; restart during send reconciles; corrupted storage is never overwritten", async () => {
  const storage = disk({
    version: 1,
    revision: 2,
    items: [
      { ...input("creating"), status: "sending", phase: "creating" },
      { ...input("sending", { computerId: "other" }), status: "sending", phase: "dispatching" },
    ],
  });
  const sent = [];
  const box = createOutbox({
    storage,
    available: () => true,
    deliver: async (item) => {
      sent.push(item.id);
      return { sessionId: 4 };
    },
  });
  await box.flush();
  assert.deepEqual(sent, ["sending"]);
  assert.equal(box.getSnapshot().items[0].status, "failed");
  let written = false;
  const corrupt = createOutbox({
    storage: {
      read: async () => {
        throw new Error("bad JSON");
      },
      write: async () => {
        written = true;
      },
    },
    available: () => true,
    deliver: async () => assert.fail(),
  });
  await assert.rejects(corrupt.enqueue(input("lost")), /bad JSON/);
  assert.equal(written, false);
  assert.match(corrupt.getSnapshot().error, /saved queue has been kept/);
});

test("a failed write after remote acceptance stops delivery until storage recovers", async () => {
  const storage = disk();
  const write = storage.write;
  let accepted = false;
  const box = createOutbox({
    storage,
    available: () => true,
    deliver: async (_item, update) => {
      await update({ phase: "dispatching" });
      accepted = true;
      storage.write = async () => {
        throw new Error("full");
      };
      return { sessionId: 4 };
    },
  });
  await box.enqueue(input("saved-on-host"));
  await box.flush();
  assert.equal(accepted, true);
  assert.match(box.getSnapshot().error, /Could not save/);
  storage.write = write;
  await box.retryStorage();
  assert.equal(box.getSnapshot().items[0].status, "queued");
  assert.equal(box.getSnapshot().items[0].phase, "dispatching");
});

test("malformed records block the queue without overwriting persisted messages", async () => {
  const storage = disk({ version: 1, revision: 4, items: [{ id: "broken" }] });
  const box = createOutbox({ storage, available: () => true, deliver: async () => assert.fail() });
  await assert.rejects(box.enqueue(input("new")), /cannot be read/);
  assert.equal(storage.saved().revision, 4);
  assert.equal(box.getSnapshot().loaded, false);
});

test("a definite pre-send setup failure can retry, and a failed lane does not hold another Chat", async () => {
  const storage = disk();
  const delivered = [];
  let interrupted = true;
  const box = createOutbox({
    storage,
    available: () => true,
    deliver: async (item, update) => {
      if (item.id === "first" && interrupted) {
        await update({ phase: "creating" });
        throw Object.assign(new Error("not sent"), { retry: "unsent" });
      }
      delivered.push(item.id);
      return { sessionId: 4 };
    },
  });
  await box.enqueue(input("first"));
  await box.enqueue(input("later"));
  await box.enqueue(input("other-chat", { conversation: "chat:9" }));
  await box.flush();
  assert.deepEqual(delivered, ["other-chat"]);
  assert.equal(box.getSnapshot().items[0].phase, "ready");
  assert.equal(canCancelOutbox(box.getSnapshot().items[0]), true);
  interrupted = false;
  await box.flush();
  await box.flush();
  assert.deepEqual(delivered, ["other-chat", "first", "later"]);
});
