const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { startTestMac, until } = require("./relay-test-kit.cjs");

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const hmac = (secret, body) => crypto.createHmac("sha256", secret).update(body).digest("hex");
const hookIdOfUrl = (url) => sha256(url.split("/hook/")[1]);

/**
 * A throwaway Mac on the local relay with Routines on and its Project open. Agents are fakes that take a turn and do
 * nothing, so a Run's first message is saved and no agent CLI ever starts.
 */
async function webhookMac(t) {
  const turns = [];
  const mac = await startTestMac(t, {
    lan: false,
    runtime: {
      registryRoots: [],
      agentCli: async () => ({ command: "fixture" }),
      createSession: (_provider, options) => ({
        startTurn: async (request) => {
          turns.push(request);
          options.emit({ type: "turn-started", turnId: `turn-${turns.length}` });
          return { turnId: `turn-${turns.length}` };
        },
        interrupt: async () => {},
        close: async () => {},
      }),
    },
  });
  await mac.client.call("project:open", [mac.project]);
  await mac.client.call("routines:enabled:save", [true]);
  const create = (extra = {}) =>
    mac.client.call("routines:create", [
      {
        name: "Sentry",
        prompt: "Look at this: {{body}}",
        trigger: { kind: "webhook" },
        target: { kind: "new-chat", projectPath: mac.project, workspace: "project" },
        ...extra,
      },
    ]);
  const list = async () => (await mac.client.call("routines:list")).routines;
  const runsOf = async (id) => (await list()).find((routine) => routine.id === id)?.runs ?? [];
  const routineChats = async () =>
    Object.values((await mac.client.call("project:snapshot", [mac.project])).state.sessions).filter((session) => session.routine);
  // The relay has registered the hook for this Mac's room.
  const registered = (hookId) => until(() => mac.relay.hooks.directory.owner(hookId) === mac.identity.hostId, "the relay to register the hook", 5000);
  return { ...mac, turns, create, list, runsOf, routineChats, registered };
}

test("a webhook Routine's URL takes a JSON POST with 202 and starts a Run whose first message holds the body as untrusted data", async (t) => {
  const mac = await webhookMac(t);
  const { routine, hookUrl } = await mac.create();
  assert.match(hookUrl, /^http:\/\/127\.0\.0\.1:\d+\/hook\/[A-Za-z0-9_-]{43}$/);
  assert.equal(routine.trigger.hookId, hookIdOfUrl(hookUrl));
  await mac.registered(routine.trigger.hookId);
  const answer = await mac.relay.postHook(hookUrl, JSON.stringify({ title: "TypeError in checkout", level: "error" }));
  assert.equal(answer.status, 202);
  assert.match(answer.json.id, /^[A-Za-z0-9_-]{22}$/);
  const [session] = await until(
    async () => {
      const chats = await mac.routineChats();
      return chats.length ? chats : null;
    },
    "the Run's Chat",
    10_000,
  );
  const messages = await until(
    async () => {
      const all = (await mac.client.call("chat:all-messages", [mac.project])).filter((message) => message.session_id === session.id && message.role === "user");
      return all.length ? all : null;
    },
    "the Run's first message",
    10_000,
  );
  assert.match(messages[0].body, /<untrusted-data source="webhook body">\n\{"title":"TypeError in checkout","level":"error"\}\n<\/untrusted-data>/);
  const [run] = await mac.runsOf(routine.id);
  assert.deepEqual(run.event, { kind: "webhook", key: `webhook:${answer.json.id}`, deliveryId: answer.json.id });
  // Acknowledged: nothing waits at the relay.
  await until(() => mac.relay.hooks.rooms.get(mac.identity.hostId).storage.deliveries.size() === 0, "the relay to drop the acked delivery");
});

test("a signed webhook Routine with a wrong signature records a failed Run, signature mismatch, and starts no Chat", async (t) => {
  const mac = await webhookMac(t);
  const { routine, hookUrl } = await mac.create({ trigger: { kind: "webhook", signed: true }, signingSecret: "shh", signingHeader: "X-Hub-Signature-256" });
  assert.equal(routine.trigger.signed, true);
  assert.deepEqual(await mac.client.call("routines:hook", [routine.id]), { url: hookUrl, signed: true, signingHeader: "x-hub-signature-256" });
  await mac.registered(routine.trigger.hookId);
  const body = '{"action":"opened"}';
  const answer = await mac.relay.postHook(hookUrl, body, { "x-hub-signature-256": `sha256=${hmac("wrong", body)}` });
  assert.equal(answer.status, 202, "the relay can't check signatures; the Mac does");
  const [run] = await until(
    async () => {
      const runs = await mac.runsOf(routine.id);
      return runs.length ? runs : null;
    },
    "the failed Run",
    5000,
  );
  assert.equal(run.status, "failed");
  assert.equal(run.error, "signature mismatch");
  await new Promise((resolve) => setTimeout(resolve, 1500)); // a tick or more
  assert.deepEqual(await mac.routineChats(), []);
  assert.equal(mac.turns.length, 0);
});

test("after routines:rotate-hook the old URL gives 404 and the new one 202", async (t) => {
  const mac = await webhookMac(t);
  const { routine, hookUrl } = await mac.create();
  await mac.registered(routine.trigger.hookId);
  const { url } = await mac.client.call("routines:rotate-hook", [routine.id]);
  assert.notEqual(url, hookUrl);
  await mac.registered(hookIdOfUrl(url));
  await until(() => mac.relay.hooks.directory.owner(routine.trigger.hookId) === null, "the old hook to be released");
  const old = await mac.relay.postHook(hookUrl, "{}");
  assert.equal(old.status, 404);
  assert.deepEqual(old.json, { error: "not found" });
  assert.equal((await mac.relay.postHook(url, "{}")).status, 202);
});

test("a delivery that reaches the Mac after its Routine was deleted is acked and starts nothing", async (t) => {
  const mac = await webhookMac(t);
  const { routine, hookUrl } = await mac.create();
  await mac.registered(routine.trigger.hookId);
  // The Mac drops off the relay; a POST waits there, and the Routine is deleted meanwhile.
  const hostsBefore = mac.relay.hostSockets.length;
  mac.relay.hostSockets.at(-1).terminate();
  await until(async () => (await mac.client.call("phone:status")).relay !== "online", "the relay host to notice");
  assert.equal((await mac.relay.postHook(hookUrl, '{"late":true}')).status, 202);
  assert.equal(mac.relay.hooks.rooms.get(mac.identity.hostId).storage.deliveries.size(), 1);
  assert.deepEqual(await mac.client.call("routines:delete", [routine.id]), { removed: true });
  // Back on the relay: the waiting delivery comes, is acked and dropped, and the hook is released.
  await until(() => mac.relay.hostSockets.length > hostsBefore, "the relay host to reconnect", 10_000);
  await until(() => mac.relay.hooks.rooms.get(mac.identity.hostId).storage.deliveries.size() === 0, "the delivery to be acked", 10_000);
  await until(() => mac.relay.hooks.directory.owner(routine.trigger.hookId) === null, "the hook to be released");
  assert.equal((await mac.relay.postHook(hookUrl, "{}")).status, 404);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.deepEqual(await mac.routineChats(), []);
  assert.deepEqual(await mac.list(), []);
});

test("with phone access off, a relay host runs for webhooks alone and stops with the last one", async (t) => {
  const mac = await webhookMac(t);
  const { routine, hookUrl } = await mac.create();
  await mac.registered(routine.trigger.hookId);
  const hosts = mac.relay.hostSockets.length;
  await mac.client.call("phone:set-enabled", [false]);
  await until(() => mac.relay.hostSockets.length > hosts, "the webhooks-only host to connect", 5000);
  await until(async () => (await mac.relay.postHook(hookUrl, '{"off":true}')).status === 202, "a POST to reach the Mac", 5000);
  await until(async () => (await mac.routineChats()).length > 0, "the Run's Chat", 10_000);
  await mac.client.call("routines:delete", [routine.id]);
  await until(() => mac.relay.hooks.directory.owner(routine.trigger.hookId) === null, "the hook to be released");
  await until(() => mac.relay.hostSockets.at(-1).readyState === 3, "the webhooks-only host to close", 5000);
});

test("after a Phone Reset the Mac's new room takes its hooks back with proof, and the next POST reaches it", async (t) => {
  const mac = await webhookMac(t);
  const { routine, hookUrl } = await mac.create();
  await mac.registered(routine.trigger.hookId);
  const oldRoom = mac.identity.hostId;
  await mac.client.call("phone:reset");
  const { readIdentity } = require("./relay-identity.cjs");
  const fresh = await until(async () => {
    const identity = await readIdentity(mac.dataDir);
    return identity.hostId !== oldRoom ? identity : null;
  }, "the new identity");
  // The old room never let go (no phone was paired, so nothing holds it to release); the proof moves the hook.
  await until(() => mac.relay.hooks.directory.owner(routine.trigger.hookId) === fresh.hostId, "the hook to move to the new room", 10_000);
  assert.equal((await mac.relay.postHook(hookUrl, '{"after":"reset"}')).status, 202);
  await until(async () => (await mac.routineChats()).length > 0, "the Run's Chat", 10_000);
  assert.equal((await mac.list())[0].lastError, undefined);
});
