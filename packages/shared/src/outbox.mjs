import { retryKind } from "./send-retry.mjs";
import { ipcErrorMessage } from "./result.mjs";

export const outboxStatus = (item) => ({ queued: "Queued on this device", sending: "Sending", sent: "Sent", failed: "Needs attention" })[item.status];
export const canCancelOutbox = (item) => item.status !== "sending" && item.phase !== "dispatching";
const lane = (item) => JSON.stringify([item.computerId, item.owner, item.conversation]);
const validItem = (item) =>
  item &&
  [item.id, item.computerId, item.owner, item.conversation].every((value) => typeof value === "string" && value.length) &&
  ["queued", "sending", "sent", "failed"].includes(item.status) &&
  ["ready", "creating", "dispatching", "done"].includes(item.phase) &&
  typeof item.request?.body === "string" &&
  Array.isArray(item.request.images) &&
  Array.isArray(item.request.files) &&
  Array.isArray(item.attachments) &&
  item.attachments.every((file) => file && typeof file.name === "string" && (typeof file.base64 === "string" || typeof file.path === "string"));

/** One durable outbox per device. Writes commit before the composer clears or any remote mutation starts. */
export function createOutbox({ storage, deliver, available, now = Date.now }) {
  let snapshot = { loaded: false, items: [], error: "" };
  let revision = 0;
  let serial = Promise.resolve();
  const listeners = new Set();
  const running = new Set();
  const publish = (next) => {
    snapshot = next;
    for (const fn of listeners) fn();
  };
  const ordered = (fn) => {
    const result = serial.then(fn);
    serial = result.catch(() => {});
    return result;
  };
  async function save(items) {
    try {
      await storage.write({ version: 1, revision: revision + 1, items }, revision);
      revision++;
      publish({ loaded: true, items, error: "" });
    } catch (error) {
      publish({ ...snapshot, error: `Could not save queued messages: ${ipcErrorMessage(error)}. Keep this app open and retry.` });
      throw error;
    }
  }
  const ready = ordered(async () => {
    try {
      const saved = await storage.read();
      if (
        saved &&
        (saved.version !== 1 ||
          !Array.isArray(saved.items) ||
          !Number.isSafeInteger(saved.revision) ||
          saved.revision < 0 ||
          !saved.items.every(validItem) ||
          new Set(saved.items.map((item) => item.id)).size !== saved.items.length)
      )
        throw new Error("The saved queue cannot be read");
      revision = saved?.revision ?? 0;
      // A crash during Worktree creation cannot safely replay it. Message sends can replay the same id after a receipt read.
      const items = (saved?.items ?? []).map((item) =>
        item.status !== "sending"
          ? item
          : {
              ...item,
              status: item.phase === "creating" ? "failed" : "queued",
              error:
                item.phase === "creating" ? "Worktree creation may have finished. Check that computer, then recover this message to the correct Chat." : "",
            },
      );
      publish({ loaded: true, items, error: "" });
    } catch (error) {
      publish({ ...snapshot, error: `Could not read queued messages: ${ipcErrorMessage(error)}. The saved queue has been kept.` });
      throw error;
    }
  });
  // Consumers see load errors in the snapshot even before anyone tries to enqueue.
  void ready.catch(() => {});
  async function update(id, patch) {
    return ordered(async () => {
      const item = snapshot.items.find((entry) => entry.id === id);
      if (!item) throw new Error("Message is no longer queued.");
      const next = { ...item, ...patch };
      await save(snapshot.items.map((entry) => (entry.id === id ? next : entry)));
      return next;
    });
  }
  async function run(item) {
    const key = lane(item);
    if (running.has(key)) return;
    running.add(key);
    try {
      const claimed = await ordered(async () => {
        const current = snapshot.items.find((entry) => entry.id === item.id);
        if (!current || current.status !== "queued" || snapshot.error) return null;
        const next = { ...current, status: "sending", error: "" };
        await save(snapshot.items.map((entry) => (entry.id === item.id ? next : entry)));
        return next;
      });
      if (!claimed) return;
      item = claimed;
      const receipt = await deliver(item, (patch) => update(item.id, patch));
      await ordered(() =>
        save(
          snapshot.items.map((entry) => {
            if (entry.id === item.id)
              return {
                ...entry,
                status: "sent",
                phase: "done",
                sentAt: now(),
                sessionId: receipt.sessionId,
                attachments: [],
                request: { ...entry.request, images: [], files: [] },
              };
            if (lane(entry) === key && entry.request.sessionId == null)
              return {
                ...entry,
                request: { ...entry.request, sessionId: receipt.sessionId, worktreeId: receipt.worktreeId ?? entry.request.worktreeId },
                createWorktree: undefined,
              };
            return entry;
          }),
        ),
      );
    } catch (error) {
      const current = snapshot.items.find((entry) => entry.id === item.id);
      if (current && !snapshot.error) {
        const retry = retryKind(error);
        const unknownSetup = current.phase === "creating" && retry !== "unsent";
        await update(item.id, {
          status: retry && !unknownSetup ? "queued" : "failed",
          ...(current.phase === "creating" && retry === "unsent" ? { phase: "ready" } : {}),
          error: unknownSetup
            ? "Worktree creation may have finished. Check that computer, then recover this message to the correct Chat."
            : retry
              ? current.phase === "dispatching"
                ? "Waiting to confirm delivery. Milagre will check the computer before retrying this message."
                : "Waiting for the computer to reconnect. Your message is saved on this device."
              : ipcErrorMessage(error),
        }).catch(() => {});
      }
    } finally {
      running.delete(key);
    }
  }
  const api = {
    ready,
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async enqueue(input) {
      await ready;
      return ordered(async () => {
        if (snapshot.error) throw new Error(snapshot.error);
        if (snapshot.items.some((item) => item.id === input.id)) throw new Error("Message is already queued.");
        const item = JSON.parse(JSON.stringify({ ...input, status: "queued", phase: "ready", createdAt: now(), error: "" }));
        await save([...snapshot.items, item]);
        return item;
      });
    },
    async remove(id) {
      await ready;
      return ordered(async () => {
        if (snapshot.error) throw new Error(snapshot.error);
        const item = snapshot.items.find((entry) => entry.id === id);
        if (item && !canCancelOutbox(item)) throw new Error("Delivery may already have started. Check delivery before removing this message.");
        await save(snapshot.items.filter((entry) => entry.id !== id));
      });
    },
    async retry(id) {
      await ready;
      await ordered(async () => {
        if (snapshot.error) throw new Error(snapshot.error);
        const item = snapshot.items.find((entry) => entry.id === id);
        if (!item || item.status === "sending" || item.status === "sent") return;
        if (item.phase === "creating") throw new Error(item.error);
        await save(snapshot.items.map((entry) => (entry.id === id ? { ...entry, status: "queued", error: "" } : entry)));
      });
      await api.flush();
    },
    async recover(id, target) {
      await ready;
      await ordered(async () => {
        if (snapshot.error) throw new Error(snapshot.error);
        const item = snapshot.items.find((entry) => entry.id === id);
        if (!item || item.status !== "failed" || !canCancelOutbox(item)) throw new Error("Check delivery before recovering this message.");
        await save(
          snapshot.items.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  status: "queued",
                  phase: "ready",
                  error: "",
                  createWorktree: undefined,
                  conversation: `chat:${target.sessionId}`,
                  request: { ...item.request, ...target },
                }
              : entry,
          ),
        );
      });
      await api.flush();
    },
    async retryStorage() {
      await ready;
      if (running.size) throw new Error("Wait for the current delivery to finish, then retry saving.");
      return ordered(() =>
        save(
          snapshot.items.map((item) =>
            item.status !== "sending"
              ? item
              : {
                  ...item,
                  status: item.phase === "creating" ? "failed" : "queued",
                  error:
                    item.phase === "creating" ? "Worktree creation may have finished. Check that computer, then recover this message to the correct Chat." : "",
                },
          ),
        ),
      );
    },
    async flush() {
      await ready;
      if (snapshot.error) return;
      const first = new Map();
      for (const item of snapshot.items) if (item.status !== "sent" && !first.has(lane(item))) first.set(lane(item), item);
      await Promise.all([...first.values()].filter((item) => item.status === "queued" && available(item)).map(run));
    },
  };
  return api;
}
