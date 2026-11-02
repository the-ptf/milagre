const { test } = require("node:test");
const assert = require("node:assert/strict");
const { polishDictation } = require("./dictation.cjs");

const fixed = (text) => async () => JSON.stringify({ text });

test("the Chat's agent fixes misheard names, given the vocabulary", async () => {
  let prompt = "";
  const result = await polishDictation(
    { text: "open the miracle settings", terms: ["Milagre"], provider: "codex" },
    {
      models: {
        claude: async () => assert.fail("the Chat's own agent answers first"),
        codex: async (request) => {
          prompt = request.prompt;
          return JSON.stringify({ text: "open the Milagre settings" });
        },
      },
    },
  );
  assert.deepEqual(result, { text: "open the Milagre settings", polished: true });
  assert.match(prompt, /<vocabulary>\nMilagre\n<\/vocabulary>/);
});

test("a failing agent hands over to the next; an answer that rewrites the message is not used", async () => {
  const failing = async () => {
    throw new Error("signed out");
  };
  assert.equal((await polishDictation({ text: "run npm test" }, { models: { claude: failing, codex: fixed("run npm test") } })).polished, true);
  const rewritten = await polishDictation({ text: "fix it" }, { models: { claude: fixed("Sure! Here is a detailed plan to fix the issue you described.") } });
  assert.deepEqual(rewritten, { text: "fix it", polished: false });
});

test("no model, or none in time, leaves the text as dictated", async () => {
  assert.deepEqual(await polishDictation({ text: " hello " }), { text: "hello", polished: false });
  const slow = () => new Promise(() => {});
  assert.deepEqual(await polishDictation({ text: "hello" }, { models: { claude: slow }, timeoutMs: 1200 }), { text: "hello", polished: false });
});

test("an explicitly chosen provider never falls back to another account", async () => {
  const calls = [];
  const result = await polishDictation(
    { text: "open miracle", provider: "codex", only: true },
    {
      models: {
        codex: async () => {
          calls.push("codex");
          throw new Error("signed out");
        },
        claude: async () => {
          calls.push("claude");
          return JSON.stringify({ text: "open Milagre" });
        },
      },
    },
  );
  assert.deepEqual(calls, ["codex"]);
  assert.deepEqual(result, { text: "open miracle", polished: false });
});
