import assert from "node:assert/strict";
import test, { mock } from "node:test";

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const reads: unknown[] = [];
(globalThis as any).window = {
  milagre: {
    on: () => ({
      readMedia: async (request: { scope: string; path: string }) => {
        reads.push(request);
        if (request.path.endsWith("gone.png")) throw new Error("Image not found");
        return { type: "image/png", size: 3, base64: "AAEC" };
      },
    }),
  },
};
const { remoteImageDataUrl, MAX_KEPT_BYTES, FAILED_MS, MAX_READS } = await import("./remote-media.ts");
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("a remote image is read once from its computer, as a data URL; a failed read is asked again only after a while", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const scope = `${ID}|/p`;
    assert.equal(await remoteImageDataUrl(scope, "/p/a.png"), "data:image/png;base64,AAEC");
    assert.equal(await remoteImageDataUrl(scope, "/p/a.png"), "data:image/png;base64,AAEC");
    assert.deepEqual(reads, [{ scope, path: "/p/a.png" }]);
    await assert.rejects(remoteImageDataUrl(scope, "/p/gone.png"), /Image not found/);
    // Every mount of the Chat asks for it again: the other Mac isn't asked again while the failure is recent.
    await assert.rejects(remoteImageDataUrl(scope, "/p/gone.png"), /Image not found/);
    assert.equal(reads.length, 2, "a recent failure isn't asked again");
    mock.timers.tick(FAILED_MS);
    await assert.rejects(remoteImageDataUrl(scope, "/p/gone.png"), /Image not found/);
    assert.equal(reads.length, 3, "an old failure is tried again");
  } finally {
    mock.timers.reset();
  }
});

test("what's kept is bounded by bytes: the least recently used image is read again", async () => {
  const before = reads.length;
  const big = "A".repeat(Math.ceil(MAX_KEPT_BYTES / 3));
  (globalThis as any).window.milagre.on = () => ({
    readMedia: async (request: unknown) => {
      reads.push(request);
      return { type: "image/png", size: big.length, base64: big };
    },
  });
  // The bridge is cached per computer, so read through a new computer id.
  const other = "7a1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f8";
  const s = `${other}|/big`;
  for (const name of ["a", "b", "c", "d"]) await remoteImageDataUrl(s, `/big/${name}.png`);
  assert.equal(reads.length - before, 4);
  await remoteImageDataUrl(s, "/big/d.png");
  assert.equal(reads.length - before, 4, "the newest is still kept");
  await remoteImageDataUrl(s, "/big/a.png");
  assert.equal(reads.length - before, 5, "the oldest was evicted");
});

test("a computer gets a few reads at a time, the image asked for last first", async () => {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  (globalThis as any).window.milagre.on = () => ({
    readMedia: (request: { path: string }) => {
      started.push(request.path);
      return new Promise((resolve) => finish.set(request.path, () => resolve({ type: "image/png", size: 1, base64: "AA" })));
    },
  });
  const computer = "8b1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f9";
  const scope = `${computer}|/many`;
  const paths = Array.from({ length: MAX_READS + 3 }, (_, index) => `/many/${index}.png`);
  const all = paths.map((path) => remoteImageDataUrl(scope, path));
  await settle();
  assert.equal(started.length, MAX_READS, "no more than MAX_READS on their way");
  assert.deepEqual(started, paths.slice(-MAX_READS).toReversed(), "the images asked for last (nearest the screen) go first");
  finish.get(started[0]!)!();
  await settle();
  assert.equal(started.length, MAX_READS + 1, "a read that ends lets the next one start");
  for (const path of paths) finish.get(path)?.();
  await settle();
  for (const path of started) finish.get(path)?.();
  await Promise.all(all);
  assert.equal(new Set(started).size, paths.length, "every image is read once");
});
