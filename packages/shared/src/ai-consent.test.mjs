import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_CONSENT_VERSION, createAiConsent, requiresAiConsent, protectAiBridge } from "./ai-consent.mjs";

function fixture(ask = async () => true, initial = null) {
  let saved = initial;
  const consent = createAiConsent({
    read: async () => saved,
    write: async (value) => {
      saved = value;
    },
    ask,
  });
  return { consent, saved: () => saved };
}

test("cancelled disclosure blocks sending, and accepting is remembered only for this version", async () => {
  let allowed = false,
    prompts = 0;
  const { consent, saved } = fixture(async () => {
    prompts++;
    return allowed;
  }, "old-version");
  await assert.rejects(consent.require(), /permission/);
  assert.equal(saved(), "old-version");
  allowed = true;
  await consent.require();
  assert.equal(saved(), AI_CONSENT_VERSION);
  await consent.require();
  assert.equal(prompts, 2);
});

test("simultaneous actions share one decision, and reset requires a new decision", async () => {
  let answer,
    prompts = 0;
  const { consent } = fixture(() => {
    prompts++;
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const first = consent.require(),
    second = consent.require();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts, 1);
  answer(true);
  await Promise.all([first, second]);
  await consent.reset();
  assert.equal(await consent.allowed(), false);
  const third = consent.require();
  await new Promise((resolve) => setImmediate(resolve));
  answer(false);
  await assert.rejects(third, /permission/);
  assert.equal(prompts, 2);
});

test("reset while a disclosure is open prevents its old acceptance from restoring permission", async () => {
  let answer;
  const { consent, saved } = fixture(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const waiting = consent.require();
  await new Promise((resolve) => setImmediate(resolve));
  await consent.reset();
  answer(true);
  await assert.rejects(waiting, /permission/);
  assert.notEqual(saved(), AI_CONSENT_VERSION);
});

test("unavailable storage fails closed, and background replies cannot open a consent prompt", async () => {
  const consent = createAiConsent({
    read: async () => {
      throw Error("locked");
    },
    write: async () => {},
    ask: async () => true,
  });
  await assert.rejects(consent.require(), /locked/);
  let prompts = 0;
  const { consent: background } = fixture(async () => {
    prompts++;
    return true;
  });
  await assert.rejects(background.require(false), /permission/);
  assert.equal(prompts, 0);
  const { consent: accepted } = fixture(async () => false, AI_CONSENT_VERSION);
  await accepted.require(false);
});

test("all AI entry points are protected while reading, stopping, and denying remain available", () => {
  for (const method of ["chat:send", "link:send", "chat:resume", "chat:limit-switch", "advisor:retry", "agent:answer-question", "live-activity:answer"])
    assert.equal(requiresAiConsent(method), true, method);
  assert.equal(requiresAiConsent("agent:respond-permission", [{ decision: "allow" }]), true);
  assert.equal(requiresAiConsent("agent:respond-permission", [{ decision: "deny" }]), false);
  assert.equal(requiresAiConsent("agent:set-permission-mode", [{ mode: "full" }]), true);
  assert.equal(requiresAiConsent("agent:set-permission-mode", [{ mode: "ask" }]), false);
  assert.equal(requiresAiConsent("bots:send", ["ops", "hi"]), true);
  assert.equal(requiresAiConsent("bots:answer-gate", ["r1", "once"]), true);
  assert.equal(requiresAiConsent("bots:answer-gate", ["r1", "deny"]), false);
  for (const method of ["chat:messages", "agent:interrupt", "advisor:stop", "push:unregister"]) assert.equal(requiresAiConsent(method), false, method);
});

test("desktop guard covers local and remote-style bridges without sending before consent", async () => {
  let sent = 0;
  const { consent } = fixture(async () => false);
  const bridge = protectAiBridge(
    Object.freeze({
      sendMessage: async () => ++sent,
      sendLinkMessage: async () => ++sent,
      resumeChat: async () => ++sent,
      answerQuestion: async () => ++sent,
      retryAdvisor: async () => ++sent,
      respondToPermission: async () => ++sent,
      interruptAgent: async () => ++sent,
    }),
    () => consent.require(),
  );
  for (const method of ["sendMessage", "sendLinkMessage", "resumeChat", "answerQuestion", "retryAdvisor"])
    await assert.rejects(bridge[method]({}), /permission/);
  assert.equal(bridge.constructor, Object);
  assert.equal(sent, 0);
  await bridge.respondToPermission("chat", "request", "deny");
  await bridge.interruptAgent("chat");
  assert.equal(sent, 2);
});

test("a failed consent write never releases a waiting send", async () => {
  let sends = 0;
  const consent = createAiConsent({
    read: async () => null,
    write: async () => {
      throw Error("storage full");
    },
    ask: async () => true,
  });
  const bridge = protectAiBridge(
    {
      sendMessage: async () => {
        sends++;
      },
    },
    () => consent.require(),
  );
  await assert.rejects(bridge.sendMessage(), /storage full/);
  assert.equal(sends, 0);
  assert.equal(await consent.allowed(), false);
});

test("desktop guard preserves dynamic bridge methods and still gates dynamic AI actions", async () => {
  let sends = 0;
  const source = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "getCliStatus") return async () => ({ claude: true });
        if (property === "sendMessage")
          return async function () {
            assert.equal(this, source);
            return ++sends;
          };
      },
    },
  );
  let accepted = false;
  const { consent } = fixture(async () => accepted);
  const bridge = protectAiBridge(source, () => consent.require());
  assert.equal(typeof bridge.getCliStatus, "function");
  assert.deepEqual(await bridge.getCliStatus(), { claude: true });
  assert.equal(typeof bridge.sendMessage, "function");
  await assert.rejects(bridge.sendMessage(), /permission/);
  assert.equal(sends, 0);
  accepted = true;
  assert.equal(await bridge.sendMessage(), 1);
});
