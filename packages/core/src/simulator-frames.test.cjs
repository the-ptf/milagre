const test = require("node:test");
const assert = require("node:assert/strict");
const { createMjpegFrames, createSnapshotFrames, normalizeAndroidSnapshot } = require("./simulator-frames.cjs");
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
const part = (data) => Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`), data, Buffer.from("\r\n")]);

test("MJPEG yields complete frames even when headers and pixels are split and the screen goes quiet", async (t) => {
  let stream;
  const source = createMjpegFrames(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" } },
      ),
  );
  t.after(() => source.close());
  const first = source.read(0);
  await new Promise(setImmediate);
  const bytes = part(jpeg);
  for (const byte of bytes) stream.enqueue(Uint8Array.of(byte));
  const frame = await first;
  assert.equal(frame.sequence, 1);
  assert.equal(frame.mimeType, "image/jpeg");
  assert.equal(frame.data, jpeg.toString("base64"));
  stream.enqueue(part(Buffer.from([0xff, 0xd8, 3, 0xff, 0xd9])));
  stream.enqueue(part(jpeg));
  await new Promise(setImmediate);
  assert.equal((await source.read(1)).sequence, 3, "slow viewers receive the latest frame");
});
test("an oversized MJPEG frame is rejected before its body can accumulate", async (t) => {
  const source = createMjpegFrames(
    async () => new Response(`--frame\r\nContent-Length: 999999999\r\n\r\n`, { headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" } }),
  );
  t.after(() => source.close());
  await assert.rejects(source.read(0), /frame|stream/i);
});
test("a display switch discards cached pixels without resetting frame sequence", async (t) => {
  let stream;
  const source = createMjpegFrames(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
        {
          headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" },
        },
      ),
  );
  t.after(() => source.close());
  const first = source.read(0);
  await new Promise(setImmediate);
  stream.enqueue(part(jpeg));
  assert.equal((await first).sequence, 1);
  assert.equal(source.discard(), 1);
  let settled = false;
  const next = source.read(0).then((frame) => {
    settled = true;
    return frame;
  });
  await new Promise(setImmediate);
  assert.equal(settled, false, "the old frame is no longer available even to a new viewer");
  stream.enqueue(part(jpeg));
  assert.equal((await next).sequence, 2);
});
test("Android snapshots over the relay cap are encoded on the Mac and temporary images are removed", async () => {
  const fs = require("node:fs/promises");
  let directory;
  const result = await normalizeAndroidSnapshot(Buffer.alloc(3 * 1024 * 1024), {
    execFile: async (binary, args, options) => {
      assert.equal(binary, "/usr/bin/sips");
      assert.ok(args.includes("1280"));
      assert.equal(options.maxBuffer, 8192);
      const input = args[8],
        output = args[10];
      directory = require("node:path").dirname(input);
      assert.equal((await fs.stat(input)).size, 3 * 1024 * 1024);
      await fs.writeFile(output, jpeg);
    },
  });
  assert.equal(result.mimeType, "image/jpeg");
  assert.deepEqual(result.data, jpeg);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});
test("a cancelled frame wait and a closed capture finish without leaving a reader pending", async () => {
  const source = createMjpegFrames(
    async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" } }),
  );
  const abort = new AbortController();
  const wait = source.read(0, abort.signal);
  abort.abort();
  assert.equal(await wait, null);
  const next = source.read(0);
  source.close();
  assert.equal(await next, null);
});
test("snapshot viewers share one capture and reject unbounded image payloads", async () => {
  let captures = 0,
    resolve;
  const source = createSnapshotFrames(
    () => {
      captures++;
      return new Promise((r) => {
        resolve = r;
      });
    },
    { intervalMs: 0 },
  );
  const a = source.read(0),
    b = source.read(0);
  await new Promise(setImmediate);
  assert.equal(captures, 1);
  resolve({ data: jpeg, mimeType: "image/jpeg" });
  assert.deepEqual(await a, await b);
  source.close();
  const bad = createSnapshotFrames(async () => ({ data: Buffer.alloc(3 * 1024 * 1024), mimeType: "image/png" }), { intervalMs: 0 });
  await assert.rejects(bad.read(0), /frame/i);
  bad.close();
});
