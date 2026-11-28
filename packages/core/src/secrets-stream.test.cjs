const test = require("node:test");
const assert = require("node:assert/strict");
const { secretRedactor } = require("@milagre/shared/secrets");
const { createSecretStream, mapStrings } = require("./secrets-stream.cjs");

const VALUE = "supersecret-token-123";

function fixture() {
  const redactor = secretRedactor([{ name: "TOKEN", value: VALUE }]);
  const stream = createSecretStream({ redactor: () => redactor });
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

test("a held tail waits through pauses and other events, and shows or is masked when its stream ends", () => {
  const { out, send } = fixture();
  send({ type: "text-delta", text: "the word super", startsMessage: true });
  send({ type: "step-started", step: { id: "s", title: "ls" } });
  send({ type: "text-delta", text: "secret-token" });
  assert.equal(
    out
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join(""),
    "the word ",
  );
  send({ type: "turn-completed" });
  const shown = out
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("");
  assert.equal(shown, "the word [secret]");
  assert.equal(out.at(-1).type, "turn-completed");
  const short = fixture();
  short.send({ type: "text-delta", text: "ends with sup", startsMessage: true });
  short.send({ type: "turn-completed" });
  assert.equal(
    short.out
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join(""),
    "ends with sup",
  );
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

test("a tail held when a new message starts moves into it, so the two halves never meet in the run text", () => {
  const { out, send } = fixture();
  send({ type: "text-delta", text: "first message supe", startsMessage: true });
  send({ type: "text-delta", text: "rsecret-token-123 second", startsMessage: true });
  send({ type: "turn-completed" });
  const deltas = out.filter((event) => event.type === "text-delta");
  assert.deepEqual(
    deltas.map((event) => [event.text, Boolean(event.startsMessage)]),
    [
      ["first message ", true],
      ["[secret TOKEN] second", true],
    ],
  );
});
