const test = require("node:test");
const assert = require("node:assert/strict");
const { secretRedactor } = require("@milagre/shared/secrets");
const { createSecretStream, mapStrings } = require("./secrets-stream.cjs");

const VALUE = "supersecret-token-123";

function fixture({ holdMs = 1000 } = {}) {
  const redactor = secretRedactor([{ name: "TOKEN", value: VALUE }]);
  const stream = createSecretStream({ redactor: () => redactor, holdMs });
  const out = [];
  const send = (event) => stream.forward("c", event, (next) => out.push(next));
  return { stream, out, send };
}

test("a value split across text chunks never reaches the reducer whole", () => {
  const { out, send } = fixture();
  send({ type: "text-delta", text: "export TOKEN=super", startsMessage: true });
  send({ type: "text-delta", text: "secret-tok" });
  send({ type: "text-delta", text: "en-123 done" });
  send({ type: "turn-completed" });
  const text = out
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("");
  assert.equal(text, "export TOKEN=[secret TOKEN] done");
  assert.equal(out.filter((event) => event.startsMessage).length, 1);
  assert.equal(out.at(-1).type, "turn-completed");
});

test("step output is held per step and flushed before the next event", () => {
  const { out, send } = fixture();
  send({ type: "step-output", id: "s1", text: `${VALUE.slice(0, 5)}` });
  send({ type: "step-output", id: "s1", text: `${VALUE.slice(5)}\n` });
  send({ type: "step-output", id: "s2", text: "other sup" });
  send({ type: "step-completed", id: "s2" });
  assert.deepEqual(
    out.map((event) => [event.type, event.id, event.text]),
    [
      ["step-output", "s1", "[secret TOKEN]\n"],
      ["step-output", "s2", "other "],
      ["step-output", "s2", "sup"],
      ["step-completed", "s2", undefined],
    ],
  );
});

test("a held tail that never completes a secret still shows after the hold", async () => {
  const { out, send } = fixture({ holdMs: 10 });
  send({ type: "text-delta", text: "the word super" });
  assert.equal(out.map((event) => event.text).join(""), "the word ");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(out.map((event) => event.text).join(""), "the word super");
});

test("other events are redacted whole, and nothing changes without secrets", () => {
  const { out, send } = fixture();
  send({ type: "step-started", step: { id: "s", title: `curl -H ${VALUE}` } });
  assert.equal(out[0].step.title, "curl -H [secret TOKEN]");
  const plain = createSecretStream({ redactor: () => null });
  const event = { type: "text-delta", text: VALUE };
  plain.forward("c", event, (next) => assert.equal(next, event));
  const untouched = { a: { b: "x" } };
  assert.equal(
    mapStrings(untouched, (text) => text),
    untouched,
  );
});
