const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Writable } = require("node:stream");
const { watch } = require("./command-watch.cjs");

test("watch subscribes before the snapshot and emits only events after its watermark", async () => {
  const client = new EventEmitter();
  const controller = new AbortController();
  const lines = [];
  client.call = async () => {
    client.emit("event", { seq: 1, channel: "agent:event", payload: { chatId: "p#1" } });
    client.emit("event", { seq: 3, channel: "agent:event", payload: { chatId: "p#2" } });
    client.emit("event", { seq: 4, channel: "project:state", payload: { chatId: "p#1" } });
    client.emit("event", { seq: 5, channel: "agent:event", payload: { chatId: "p#1" } });
    return { eventSeq: 2, projects: [] };
  };
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()));
      if (lines.length === 2) controller.abort();
      done();
    },
  });
  await watch(client, { output, chat: "p#1", channels: ["agent:event"], signal: controller.signal });
  assert.deepEqual(
    lines.map((line) => line.type),
    ["snapshot", "event"],
  );
  assert.equal(lines[1].seq, 5);
  assert.equal(client.listenerCount("event"), 0);
});

test("watch fails explicitly when its connection closes", async () => {
  const client = new EventEmitter();
  client.call = async () => ({ eventSeq: 0 });
  const output = new Writable({
    write(_chunk, _encoding, done) {
      client.emit("close");
      done();
    },
  });
  await assert.rejects(watch(client, { output }), /Reconnect for a fresh snapshot/);
  assert.equal(client.listenerCount("close"), 0);
});
