const BASE = "https://exp.host/--/api/v2/push/";
const RETRYABLE = new Set(["MessageRateExceeded"]);

function createExpoPush({
  fetcher = fetch,
  accessToken = process.env.EXPO_PUSH_ACCESS_TOKEN,
  timeoutMs = 10000,
  retryDelaysMs = [1000, 3000],
  receiptDelayMs = 15 * 60 * 1000,
  maxQueued = 256,
  onInvalid = () => {},
  onError = () => {},
} = {}) {
  const queue = [];
  const receipts = new Map();
  const shutdown = new AbortController();
  const controllers = new Set();
  let processing;
  let receiptTimer;
  let receiptWork;
  let closed = false;
  const report = () => {
    try {
      onError(new Error("Mobile push delivery failed. Check Expo push credentials and network access."));
    } catch {}
  };
  async function request(route, body) {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(BASE + route, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Object.assign(new Error("Expo request failed"), { retryable: response.status === 429 || response.status >= 500 });
      const value = await response.json();
      if (value.errors || !value.data) throw Object.assign(new Error("Invalid Expo response"), { retryable: false });
      return value.data;
    } catch (error) {
      if (error.retryable === undefined) error.retryable = true;
      throw error;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }
  async function pause(ms) {
    if (closed) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        shutdown.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      shutdown.signal.addEventListener("abort", finish, { once: true });
    });
  }
  function scheduleReceipts() {
    clearTimeout(receiptTimer);
    if (closed || !receipts.size || receiptWork) return;
    const due = Math.min(...[...receipts.values()].map((receipt) => receipt.due));
    receiptTimer = setTimeout(
      () => {
        receiptWork = checkReceipts()
          .catch(report)
          .finally(() => {
            receiptWork = undefined;
            scheduleReceipts();
          });
      },
      Math.max(1, due - Date.now()),
    );
    receiptTimer.unref();
  }
  async function checkReceipts() {
    const batch = [...receipts].filter(([, receipt]) => receipt.due <= Date.now()).slice(0, 100);
    if (!batch.length || closed) return;
    let result;
    try {
      result = await request("getReceipts", { ids: batch.map(([id]) => id) });
    } catch {
      report();
    }
    for (const [id, receipt] of batch) {
      if (closed) return;
      const entry = result?.[id];
      if (entry?.status === "ok" || entry?.status === "error") {
        receipts.delete(id);
        if (entry.details?.error === "DeviceNotRegistered") await onInvalid(receipt.token);
        else if (entry.status === "error") report();
      } else if (++receipt.attempts >= 3) {
        receipts.delete(id);
        report();
      } else receipt.due = Date.now() + receiptDelayMs;
    }
  }
  async function deliver({ message, isCurrent }) {
    // oxlint-disable-next-line no-unmodified-loop-condition -- close() sets closed while a send awaits
    for (let attempt = 0; !closed && isCurrent(); attempt++) {
      try {
        const data = await request("send", message);
        const ticket = Array.isArray(data) ? data[0] : data;
        if (ticket?.status === "ok" && typeof ticket.id === "string") {
          if (receipts.size >= 1000) {
            receipts.delete(receipts.keys().next().value);
            report();
          }
          receipts.set(ticket.id, { token: message.to, due: Date.now() + receiptDelayMs, attempts: 0 });
          scheduleReceipts();
          return;
        }
        if (ticket?.details?.error === "DeviceNotRegistered") {
          await onInvalid(message.to);
          return;
        }
        throw Object.assign(new Error("Push ticket failed"), { retryable: RETRYABLE.has(ticket?.details?.error) });
      } catch (error) {
        if (closed) return;
        if (!error.retryable || attempt >= retryDelaysMs.length) {
          report();
          return;
        }
        await pause(retryDelaysMs[attempt]);
      }
    }
  }
  function pump() {
    if (processing || closed) return;
    processing = (async () => {
      // oxlint-disable-next-line no-unmodified-loop-condition -- close() sets closed while a send awaits
      while (queue.length && !closed) {
        const entry = queue.shift();
        try {
          await deliver(entry);
        } catch {
          report();
        } finally {
          entry.resolve();
        }
      }
    })().finally(() => {
      processing = undefined;
      if (queue.length) pump();
    });
  }
  return {
    send(message, isCurrent = () => true) {
      if (closed) return Promise.resolve();
      if (queue.length >= maxQueued) return Promise.reject(new Error("Mobile push queue is full"));
      const result = new Promise((resolve) => queue.push({ message, isCurrent, resolve }));
      pump();
      return result;
    },
    async close() {
      closed = true;
      clearTimeout(receiptTimer);
      receipts.clear();
      shutdown.abort();
      for (const controller of controllers) controller.abort();
      for (const entry of queue.splice(0)) entry.resolve();
      await Promise.all([processing, receiptWork]);
    },
  };
}
module.exports = { createExpoPush };
