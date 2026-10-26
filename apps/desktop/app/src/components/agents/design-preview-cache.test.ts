import assert from "node:assert/strict";
import test from "node:test";
import { canvasPreviewSource, createDesignPreviewCache, designLiveZoom, designPreviewKey, designPreviewScale } from "./design-preview-cache.ts";
const doc = { schemaVersion: 1 as const, width: 100, height: 100, nodes: [] };
function fixture(limit = 48, fail = false) {
  const tasks: (() => void)[] = [];
  let builds = 0;
  let time = 0;
  const cache = createDesignPreviewCache(
    limit,
    () => {
      builds++;
      time += 5;
      if (fail) throw Error("Invalid design");
      return "image";
    },
    (run) => {
      tasks.push(run);
      return 0;
    },
    () => time,
  );
  return { cache, tasks, builds: () => builds };
}

test("preview work is deferred, deduplicated and split at the 8ms budget", () => {
  const { cache, tasks, builds } = fixture();
  const seen: unknown[] = [];
  cache.request("a", doc, (r) => seen.push(r));
  cache.request("a", doc, (r) => seen.push(r));
  cache.request("b", doc, (r) => seen.push(r));
  cache.request("c", doc, (r) => seen.push(r));
  assert.equal(builds(), 0);
  assert.equal(tasks.length, 1);
  tasks.shift()!();
  assert.equal(builds(), 2);
  assert.equal(seen.length, 3);
  assert.equal(tasks.length, 1);
  tasks.shift()!();
  assert.equal(builds(), 3);
  cache.request("a", doc, (r) => seen.push(r));
  assert.equal(builds(), 3, "warm reads use the immutable cached version");
});

test("unmounted consumers cancel work; version eviction cannot be undone by queued jobs", () => {
  const { cache, tasks, builds } = fixture();
  const seen: unknown[] = [];
  const cancel = cache.request("gone", doc, (r) => seen.push(r));
  cancel();
  cache.request("evicted", doc, (r) => seen.push(r));
  cache.delete("evicted");
  tasks.shift()!();
  assert.equal(builds(), 1);
  assert.equal(seen.length, 1, "a mounted consumer still paints an evicted version");
  assert.equal(cache.get("evicted"), undefined);
  assert.equal(cache.get("gone"), undefined);
});

test("preview cache bounds retained values and isolates Chat and held version keys", () => {
  const { cache, tasks } = fixture(2);
  const keys = [designPreviewKey("chat", "id", 1), designPreviewKey("chat", "id", 2), designPreviewKey("other", "id", 1)];
  for (const key of keys) cache.request(key, doc, () => {});
  while (tasks.length) tasks.shift()!();
  assert.equal(cache.get(keys[0]!), undefined);
  assert.deepEqual(cache.get(keys[1]!), { src: "image" });
  assert.deepEqual(cache.get(keys[2]!), { src: "image" });
});

test("failed SVG builds settle with a live-frame fallback and do not stall following jobs", () => {
  const { cache, tasks } = fixture(48, true);
  const seen: unknown[] = [];
  cache.request("bad", doc, (r) => seen.push(r));
  cache.request("next", doc, (r) => seen.push(r));
  tasks.shift()!();
  assert.deepEqual(seen, [{ error: true }, { error: true }]);
});

test("zoom hysteresis keeps the current mode between .22 and .25", () => {
  assert.equal(designLiveZoom(false, 0.249), false);
  assert.equal(designLiveZoom(false, 0.25), true);
  assert.equal(designLiveZoom(true, 0.22), true);
  assert.equal(designLiveZoom(true, 0.219), false);
});

test("an artifact evicted before its first preview request cannot be retained later", () => {
  const { cache, tasks } = fixture();
  cache.delete("already-evicted");
  const seen: unknown[] = [];
  cache.request(
    "already-evicted",
    doc,
    (result) => seen.push(result),
    () => false,
  );
  tasks.shift()!();
  assert.deepEqual(seen, [{ src: "image" }]);
  assert.equal(cache.get("already-evicted"), undefined);
});

test("async raster work is deduplicated, capped at two and discards canceled generations", async () => {
  const tasks: (() => void)[] = [];
  const pending: ((src: string) => void)[] = [];
  const seen: string[] = [];
  const cache = createDesignPreviewCache(
    48,
    () => new Promise<string>((resolve) => pending.push(resolve)),
    (run) => {
      tasks.push(run);
      return 0;
    },
  );
  cache.request("one", doc, () => seen.push("one"));
  const cancel = cache.request("two", doc, () => seen.push("stale"));
  cache.request("three", doc, () => seen.push("three"));
  cache.request("one", doc, () => seen.push("one again"));
  tasks.shift()!();
  assert.equal(pending.length, 2);
  cancel();
  cache.request("two", doc, () => seen.push("replacement"));
  pending.shift()!("image-one");
  pending.shift()!("stale-image");
  await Promise.resolve();
  assert.deepEqual(seen, ["one", "one again"]);
  assert.equal(cache.get("two"), undefined);
  tasks.shift()!();
  assert.equal(pending.length, 2);
  pending.shift()!("image-three");
  pending.shift()!("image-new-two");
  await Promise.resolve();
  assert.deepEqual(seen, ["one", "one again", "three", "replacement"]);
  assert.deepEqual(cache.get("two"), { src: "image-new-two" });
});

test("display-density variants use their requested ratio and leave with the artifact version", () => {
  const tasks: (() => void)[] = [];
  const ratios: number[] = [];
  const cache = createDesignPreviewCache(
    48,
    (_document, ratio) => {
      ratios.push(ratio);
      return "image";
    },
    (run) => {
      tasks.push(run);
      return 0;
    },
  );
  cache.request(
    "version\n1",
    doc,
    () => {},
    () => true,
    1,
  );
  cache.request(
    "version\n2",
    doc,
    () => {},
    () => true,
    2,
  );
  tasks.shift()!();
  assert.deepEqual(ratios, [1, 2]);
  cache.delete("version");
  assert.equal(cache.get("version\n1"), undefined);
  assert.equal(cache.get("version\n2"), undefined);
});

test("a queued drain from a synchronous completion cannot overrun the SVG slots", () => {
  const tasks: (() => void)[] = [];
  let starts = 0;
  const cache = createDesignPreviewCache(
    48,
    () => (++starts === 1 ? "sync" : new Promise<string>(() => {})),
    (run) => {
      tasks.push(run);
      return 0;
    },
    () => 0,
  );
  for (const key of ["sync", "one", "two", "three"]) cache.request(key, doc, () => {});
  tasks.shift()!();
  assert.equal(starts, 3);
  tasks.shift()!();
  assert.equal(starts, 3, "the already-scheduled task still checks capacity before starting");
});

test("released SVG slots overlap at most twelve asynchronous encodes", async () => {
  const tasks: (() => void)[] = [];
  const slots: (() => void)[] = [];
  const encodes: ((src: string) => void)[] = [];
  let starts = 0;
  const cache = createDesignPreviewCache(
    48,
    (_document, _ratio, release) => {
      starts++;
      slots.push(release);
      return new Promise<string>((resolve) => encodes.push(resolve));
    },
    (run) => {
      tasks.push(run);
      return 0;
    },
    () => 0,
  );
  for (let i = 0; i < 14; i++) cache.request(String(i), doc, () => {});
  tasks.shift()!();
  assert.equal(starts, 2);
  for (let i = 0; i < 6; i++) {
    slots.splice(0).forEach((release) => release());
    if (tasks.length) tasks.shift()!();
  }
  assert.equal(starts, 12);
  encodes.shift()!("encoded");
  await Promise.resolve();
  tasks.shift()!();
  assert.equal(starts, 13);
});

test("cache capacity counts versions and retains both Fit and zoom variants for a 35-design round trip", () => {
  const tasks: (() => void)[] = [];
  const cache = createDesignPreviewCache(
    48,
    () => "image",
    (run) => {
      tasks.push(run);
      return 0;
    },
    () => 0,
  );
  for (const bucket of [0.0625, 0.25])
    for (let i = 0; i < 35; i++)
      cache.request(
        `${i}\n1\n${bucket}`,
        doc,
        () => {},
        () => true,
        1,
        bucket,
        String(i),
      );
  while (tasks.length) tasks.shift()!();
  assert.deepEqual(cache.get("0\n1\n0.0625"), { src: "image" });
  assert.deepEqual(cache.get("0\n1\n0.25"), { src: "image" });
  cache.delete("0");
  assert.equal(cache.get("0\n1\n0.0625"), undefined);
  assert.equal(cache.get("0\n1\n0.25"), undefined);
});

test("preview buckets round up and the raster source preserves the full viewBox at both display densities", () => {
  assert.deepEqual([0.05, 0.0625, 0.063, 0.125, 0.126, 0.235, 1].map(designPreviewScale), [0.0625, 0.0625, 0.125, 0.125, 0.25, 0.25, 0.25]);
  const source = { ...doc, width: 1440, height: 900 };
  const fit = canvasPreviewSource(source, 1, 0.0625);
  assert.equal(fit.width, 90);
  assert.equal(fit.height, 57);
  assert.match(fit.svg, /<svg[^>]*width="90" height="57" viewBox="0 0 1440 900"/);
  const zoom = canvasPreviewSource(source, 2, 0.25);
  assert.equal(zoom.width, 720);
  assert.equal(zoom.height, 450);
  assert.match(zoom.svg, /<rect[^>]*width="1440" height="900"/);
  const tall = canvasPreviewSource({ ...source, height: 3840 }, 2, 0.25);
  assert.equal(tall.height, 1024);
  assert.equal(tall.width, 384);
});

test("canvas admission bounds outstanding RGBA pixels even when SVG slots have been released", () => {
  const tasks: (() => void)[] = [];
  const slots: (() => void)[] = [];
  const pixels: (() => void)[] = [];
  let starts = 0;
  const cache = createDesignPreviewCache(
    48,
    (_document, _ratio, release, _scale, releasePixels) => {
      starts++;
      slots.push(release);
      pixels.push(releasePixels);
      return new Promise<string>(() => {});
    },
    (run) => {
      tasks.push(run);
      return 0;
    },
    () => 0,
  );
  const big = { ...doc, width: 3840, height: 3840 };
  for (let i = 0; i < 8; i++)
    cache.request(
      String(i),
      big,
      () => {},
      () => true,
      2,
      0.25,
    );
  tasks.shift()!();
  slots.splice(0).forEach((release) => release());
  tasks.shift()!();
  slots.splice(0).forEach((release) => release());
  assert.equal(starts, 4, "four 1024-square canvases fill the 16 MiB budget");
  assert.equal(tasks.length, 0, "a full pixel budget cannot busy-poll");
  pixels[0]!();
  pixels[0]!();
  tasks.shift()!();
  assert.equal(starts, 5, "canvas release is idempotent and admits exactly one replacement");
});
