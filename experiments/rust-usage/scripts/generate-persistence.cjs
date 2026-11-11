#!/usr/bin/env node
// Actual Node cache implementations, restricted to freshly created synthetic temporary data.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const base = path.resolve(__dirname, "../../../packages/core/src");
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "usage-persistence-fixture-")));
const now = Date.parse("2026-10-30T12:00:00Z");
const originalMask = process.umask();
function check(file) {
  if (typeof file !== "string" || !path.resolve(file).startsWith(temp + path.sep)) throw Error("Fixture filesystem escape");
  return file;
}
const promises = Object.fromEntries(
  ["mkdir", "writeFile", "readFile", "stat", "readdir", "realpath", "open"].map((name) => [name, (file, ...args) => fs.promises[name](check(file), ...args)]),
);
promises.rename = (from, to) => fs.promises.rename(check(from), check(to));
const disk = { readFileSync: (file, ...args) => fs.readFileSync(check(file), ...args), promises };
function load(name) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(base, name), "utf8"),
    {
      module,
      Buffer,
      setImmediate,
      console: {
        ...console,
        warn(...args) {
          throw Error(args.join(" "));
        },
      },
      require(id) {
        if (id === "node:fs") return disk;
        if (id === "node:path") return path;
        if (id === "@milagre/shared/providers") return { PROVIDERS: ["codex", "claude", "antigravity", "kiro"] };
        throw Error("Blocked module " + id);
      },
    },
    { filename: name },
  );
  return module.exports;
}
const usage = load("usage-cache.cjs"),
  scan = load("token-usage-scan.cjs"),
  pricing = load("token-usage-pricing.cjs");
const last = {
  windows: [{ id: "session", label: "Session", shortLabel: "5h", usedPercent: 42, resetsAt: null, discard: "fixture" }],
  updatedAt: new Date(now).toISOString(),
  bankedResets: 2,
  discard: "fixture",
};
const blocked = { until: now + 60000, message: "fixture backoff", discard: "fixture" };
const catalog = {
  "claude-fixture": { input_cost_per_token: 1, output_cost_per_token: 2, cache_read_input_token_cost: 0.5 },
  "vendor/skip": { input_cost_per_token: 1, output_cost_per_token: 2 },
};
const line =
  JSON.stringify({
    type: "assistant",
    timestamp: new Date(now).toISOString(),
    sessionId: "fixture",
    requestId: "r1",
    cwd: "/fixture/project",
    entrypoint: "sdk",
    message: { id: "m1", model: "claude-fixture", usage: { input_tokens: 12, output_tokens: 3 } },
  }) + "\n";
const normalize = (value) => JSON.parse(JSON.stringify(value).replaceAll(temp, "/fixture"));
(async () => {
  const modes = [];
  let output;
  for (const mask of [0o022, 0o077]) {
    process.umask(mask);
    const dir = path.join(temp, mask.toString(8));
    fs.mkdirSync(dir);
    const quotaFile = path.join(dir, "usage.json"),
      scanFile = path.join(dir, "scan.json"),
      priceFile = path.join(dir, "prices.json");
    const store = usage.createUsageStore({ file: quotaFile });
    store.setLast("claude", last);
    store.setBlocked("claude", blocked);
    await store.idle();
    const prices = pricing.createTokenPricing({ file: priceFile, fetchCatalog: async () => catalog, now: () => now });
    prices.current();
    await prices.idle();
    const root = path.join(dir, "transcripts");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "fixture.jsonl"), line);
    const scanner = scan.createTokenUsageScan({ cacheFile: scanFile, roots: async () => [{ provider: "claude", dir: root }], now: () => now });
    await scanner.scan();
    const reopened = scan.createTokenUsageScan({ cacheFile: scanFile, roots: async () => [{ provider: "claude", dir: root }], now: () => now });
    const saved = Object.fromEntries(
      [
        ["quota", quotaFile],
        ["scan", scanFile],
        ["pricing", priceFile],
      ].map(([k, f]) => [k, JSON.parse(fs.readFileSync(f, "utf8"))]),
    );
    if (!output)
      output = {
        now,
        last,
        blocked,
        catalog,
        line,
        saved: normalize(saved),
        reopened: {
          quota: usage.cachedSnapshot(usage.createUsageStore({ file: quotaFile }), now),
          scanRows: reopened.rows(),
          scanFinished: reopened.finished(),
          scanChanged: await reopened.scan(),
          pricing: pricing
            .createTokenPricing({
              file: priceFile,
              now: () => now,
              fetchCatalog: () => {
                throw Error("must not fetch");
              },
            })
            .current(),
        },
      };
    modes.push({ umask: mask, files: [quotaFile, scanFile, priceFile].map((f) => fs.statSync(f).mode & 0o777), directory: fs.statSync(dir).mode & 0o777 });
  }
  output.modes = modes;
  output.malformed = [];
  for (const contents of ["{", "null", "{}", '{"version":2,"files":{}}']) {
    const file = path.join(temp, "malformed.json");
    fs.writeFileSync(file, contents);
    const q = usage.createUsageStore({ file });
    const s = scan.createTokenUsageScan({ cacheFile: file, roots: async () => [], now: () => now });
    const p = pricing.createTokenPricing({
      file,
      now: () => now,
      fetchCatalog: () => {
        throw Error("must not fetch");
      },
    });
    output.malformed.push({ contents, quota: usage.cachedSnapshot(q, now), scanRows: s.rows(), scanFinished: s.finished(), pricingStatus: p.status() });
  }
  fs.writeFileSync(path.join(__dirname, "../tests/fixtures/persistence.json"), JSON.stringify(output, null, 2) + "\n");
  console.log("Node persistence: 3 cache shapes, 2 umasks, restart and 4 malformed cases");
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.umask(originalMask);
    fs.rmSync(temp, { recursive: true, force: true });
  });
