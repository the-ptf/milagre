const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable, Writable } = require("node:stream");
const { session } = require("./command-session.cjs");

test("session keeps one client for multiple commands and emits results, events and validation errors", async () => {
  const client = new EventEmitter();
  const calls = [];
  const lines = [];
  client.call = async (method, args) => {
    calls.push([method, args]);
    client.emit("event", { channel: "browser:changed", seq: 1, payload: {} });
    return "ok";
  };
  await session(client, {
    input: Readable.from([
      Buffer.from('{"id":1,"method":"browser:open","args":[{}]}\n{'),
      Buffer.from('"id":2,"method":"browser:input","args":[{}]}\ninvalid\n'),
    ]),
    output: new Writable({
      write(chunk, _encoding, done) {
        lines.push(JSON.parse(chunk.toString()));
        done();
      },
    }),
  });
  assert.deepEqual(
    calls.map(([method]) => method),
    ["browser:open", "browser:input"],
  );
  assert.equal(lines.filter((line) => line.result === "ok").length, 2);
  assert.equal(lines.filter((line) => line.type === "event").length, 2);
  assert.equal(lines.at(-1).error.code, "INVALID_REQUEST");
  assert.equal(client.listenerCount("event"), 0);
});
