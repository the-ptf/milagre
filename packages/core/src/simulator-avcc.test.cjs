const test = require("node:test");
const assert = require("node:assert/strict");
const { TAG, envelope, createAvccRelay, createAnnexBConverter, createAvccFrames, createEnvelopeReader } = require("./simulator-avcc.cjs");

const slice = (frameNum, body) => envelope(TAG.delta, Buffer.concat([Buffer.from([0, 0, 0, 20, 0x21, 0xe0, frameNum, 0, frameNum]), Buffer.alloc(13), body]));
const tags = (batch) => createEnvelopeReader()(Buffer.from(batch.data, "base64")).map((e) => e.tag);
const started = (relay) => {
  relay.push(TAG.description, envelope(TAG.description, Buffer.from([1, 0x64, 0, 0x1f])));
  relay.push(TAG.keyframe, envelope(TAG.keyframe, Buffer.alloc(40, 1)));
  return relay.read(0).sequence;
};

test("a still screen's repeated deltas wait for the viewer's wait to end, and a real change goes at once", () => {
  const relay = createAvccRelay();
  let after = started(relay);
  relay.push(TAG.delta, slice(1, Buffer.alloc(30, 7)));
  after = relay.read(after, { hold: true }).sequence;
  for (let frame = 2; frame < 6; frame++) relay.push(TAG.delta, slice(frame, Buffer.alloc(30, 7)));
  assert.equal(relay.read(after, { hold: true }), null, "only the idle floor's repeats are new");
  const flushed = relay.read(after);
  assert.deepEqual(tags(flushed), [TAG.delta, TAG.delta, TAG.delta, TAG.delta], "they still go, in order, when the wait ends");
  relay.push(TAG.delta, slice(6, Buffer.alloc(30, 7)));
  relay.push(TAG.delta, slice(7, Buffer.alloc(30, 9)));
  assert.deepEqual(tags(relay.read(flushed.sequence, { hold: true })), [TAG.delta, TAG.delta], "a changed picture carries the repeats before it");
});

test("after a display switch repeats are served at once so fresh pixels can settle the switch", () => {
  const relay = createAvccRelay();
  let after = started(relay);
  relay.push(TAG.delta, slice(1, Buffer.alloc(30, 7)));
  after = relay.read(after).sequence;
  relay.release(3000);
  relay.push(TAG.delta, slice(2, Buffer.alloc(30, 7)));
  assert.notEqual(relay.read(after, { hold: true }), null);
});

test("a viewer joining a long group gets a fresh keyframe instead of a replay, or the replay if none comes", async () => {
  let asked = 0;
  const relay = createAvccRelay({ requestKeyframe: () => asked++, replayFrames: 3, keyframeWaitMs: 40 });
  started(relay);
  for (let frame = 1; frame <= 5; frame++) relay.push(TAG.delta, slice(frame, Buffer.alloc(30, frame)));
  assert.equal(relay.read(0), null);
  await new Promise(setImmediate);
  assert.equal(asked, 1);
  relay.push(TAG.keyframe, envelope(TAG.keyframe, Buffer.alloc(40, 2)));
  assert.deepEqual(tags(relay.read(0)), [TAG.description, TAG.keyframe]);
  for (let frame = 1; frame <= 5; frame++) relay.push(TAG.delta, slice(frame, Buffer.alloc(30, frame)));
  assert.equal(relay.read(0), null);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(tags(relay.read(0)).length, 7, "the source never answered: replay the group");
  await new Promise(setImmediate);
  assert.equal(asked, 2);
});

test("a group that grows past its cap asks for a keyframe once", async () => {
  let asked = 0;
  const relay = createAvccRelay({ requestKeyframe: () => asked++, maxGroupFrames: 4 });
  started(relay);
  for (let frame = 1; frame <= 10; frame++) relay.push(TAG.delta, slice(frame, Buffer.alloc(30, frame)));
  await new Promise(setImmediate);
  assert.equal(asked, 1);
});

test("serve-emu's Annex-B access units become an avcC description, keyframes and deltas", () => {
  const convert = createAnnexBConverter();
  const sps = [0x67, 0x64, 0, 0x1f, 0xac],
    pps = [0x68, 0xee, 0x3c];
  const key = convert(Buffer.from([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, ...sps, 0, 0, 1, ...pps, 0, 0, 1, 0x65, 1, 2, 0, 0, 1, 0x65, 3]));
  assert.deepEqual(
    key.map((unit) => unit.tag),
    [TAG.description, TAG.keyframe],
  );
  assert.deepEqual([...key[0].bytes.subarray(5)], [1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 5, ...sps, 1, 0, 3, ...pps]);
  assert.deepEqual([...key[1].bytes.subarray(5)], [0, 0, 0, 3, 0x65, 1, 2, 0, 0, 0, 2, 0x65, 3], "the access unit delimiter is dropped");
  assert.deepEqual(
    convert(Buffer.from([0, 0, 0, 1, 0x41, 9])).map((unit) => unit.tag),
    [TAG.delta],
  );
  assert.deepEqual(
    convert(Buffer.from([0, 0, 1, ...sps, 0, 0, 1, ...pps, 0, 0, 1, 0x65, 4])).map((unit) => unit.tag),
    [TAG.keyframe],
    "an unchanged configuration is not sent again",
  );
  assert.deepEqual(createAnnexBConverter()(Buffer.from([0, 0, 1, 0x41, 9])), [], "nothing is decodable before the first keyframe");
});

test("a helper stream that ends fails its readers, and a closed one stops them", async () => {
  let sink;
  const ended = createAvccFrames(async (s) => {
    sink = s;
    sink.push(TAG.description, envelope(TAG.description, Buffer.from([1, 0x64, 0, 0x1f])));
    sink.push(TAG.keyframe, envelope(TAG.keyframe, Buffer.alloc(10)));
  });
  const first = await ended.read(0);
  assert.equal(first.mimeType, "video/avcc");
  await assert.rejects(ended.read(first.sequence), /video stream failed/);
  const open = createAvccFrames(() => new Promise(() => {}), { waitMs: 20 });
  assert.equal(await open.read(0), null, "the viewer's wait ends without frames");
  open.close();
  assert.equal(await open.read(0), null);
});
