import { test } from "node:test";
import assert from "node:assert/strict";
import { retryKind, retrySend } from "./send-retry.mjs";

// A clock the waits move forward, so a test runs the whole budget at once.
function clock() {
  let time = 0;
  const waits = [];
  return {
    now: () => time,
    wait: async (ms) => {
      waits.push(ms);
      time += ms;
    },
    waits,
  };
}

test("a busy or unreachable computer is told apart from one that answered", () => {
  assert.equal(retryKind(Object.assign(new Error("Your computer is busy right now. Try again in a moment."), { status: 429 })), "unsent");
  assert.equal(retryKind(Object.assign(new Error("Bridge is closing"), { status: 503 })), "unsent");
  assert.equal(retryKind(Object.assign(new Error("Service unavailable"), { status: 503 })), "unknown");
  assert.equal(retryKind(new Error("Milagre host is disconnected. Your command was not sent.")), "unsent");
  assert.equal(retryKind(Object.assign(new Error("Connection lost."), { retry: "unknown" })), "unknown");
  assert.equal(retryKind(Object.assign(new Error("The computer took too long to answer"), { status: 504 })), "unknown");
  assert.equal(retryKind(Object.assign(new Error("Mac unreachable"), { name: "RelayTransportError", code: "host-offline" })), "unknown");
  assert.equal(retryKind(Object.assign(new Error("Lost"), { name: "RelayTransportError", code: "lost" })), "unknown");
  // The bridge's own daemon call timed out, forwarded with the host's refusal status.
  assert.equal(retryKind(Object.assign(new Error("Timed out: chat:send. It may still be running."), { status: 409 })), "unknown");
  assert.equal(retryKind(new Error("Error invoking remote method 'chat:send': Error: Daemon connection closed")), "unknown");
  // The host's answers: a retry would get them again.
  assert.equal(retryKind(Object.assign(new Error("That chat is no longer in the project."), { status: 409 })), null);
  assert.equal(retryKind(Object.assign(new Error("Re-pair"), { name: "RelayTransportError", code: "bad-token" })), null);
  assert.equal(retryKind(new Error("Choose a base branch before sending.")), null);
  assert.equal(retryKind(undefined), null);
});

test("a send the computer turned away is tried again until it goes", async () => {
  const time = clock();
  let tries = 0;
  const result = await retrySend(
    async () => {
      tries++;
      if (tries < 4) throw Object.assign(new Error("busy"), { status: 429 });
      return { sessionId: 7 };
    },
    { retryable: (error) => retryKind(error) !== null, ...time },
  );
  assert.deepEqual(result, { sessionId: 7 });
  assert.equal(tries, 4);
  assert.deepEqual(time.waits, [1000, 2000, 4000]);
});

test("the waits grow to 30 s and stop when the budget runs out", async () => {
  const time = clock();
  const busy = Object.assign(new Error("busy"), { status: 429 });
  await assert.rejects(
    retrySend(
      async () => {
        throw busy;
      },
      { retryable: () => true, budget: 100_000, ...time },
    ),
    busy,
  );
  assert.deepEqual(time.waits, [1000, 2000, 4000, 8000, 15000, 30000, 30000]);
  assert.ok(time.now() <= 100_000);
});

test("an answer from the computer is not tried again", async () => {
  const time = clock();
  let tries = 0;
  const refused = Object.assign(new Error("That chat is no longer in the project."), { status: 409 });
  await assert.rejects(
    retrySend(
      async () => {
        tries++;
        throw refused;
      },
      { retryable: (error) => retryKind(error) !== null, ...time },
    ),
    refused,
  );
  assert.equal(tries, 1);
  assert.deepEqual(time.waits, []);
});

test("a call that may have run is retried only when the caller allows it", async () => {
  const time = clock();
  let tries = 0;
  const lost = Object.assign(new Error("Connection lost."), { retry: "unknown" });
  await assert.rejects(
    retrySend(
      async () => {
        tries++;
        throw lost;
      },
      { retryable: (error) => retryKind(error) === "unsent", ...time },
    ),
    lost,
  );
  assert.equal(tries, 1);
});
