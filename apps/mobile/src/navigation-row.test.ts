import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// Exercise the production cell cache without loading the screen's native controls in Node.
const source = readFileSync(new URL("./navigation-row.tsx", import.meta.url), "utf8");
const helper = source.slice(source.indexOf("export function createNavigationRowCache"), source.indexOf("/** One row of the list; memoized"));
const { createNavigationRowCache } = (await import("data:text/javascript," + encodeURIComponent(stripTypeScriptTypes(helper)))) as {
  createNavigationRowCache: typeof import("./navigation-row").createNavigationRowCache;
};

test("unchanged rows keep all props when a different computer publishes", () => {
  const cache = createNavigationRowCache<{ key: string; title: string }, object, object>();
  const view = { busy: false };
  const copyA = { name: "a" };
  const copyB = { name: "b" };
  const a = cache.pick({ key: "a", title: "A" }, view, copyA);
  const b = cache.pick({ key: "b", title: "B" }, view, copyB);
  assert.equal(cache.pick({ key: "a", title: "A" }, view, copyA), a);
  const changedB = cache.pick({ key: "b", title: "New B" }, view, { name: "new b" });
  assert.notEqual(changedB, b);
  assert.equal(cache.pick({ key: "a", title: "A" }, view, copyA), a);
  assert.notEqual(cache.pick({ key: "a", title: "A" }, { busy: true }, copyA), a, "shared visual state still updates rows");
});

test("copy changes update the row even when its item is unchanged; removed rows are pruned", () => {
  const cache = createNavigationRowCache<{ key: string }, object, object>();
  const view = {};
  const copy = {};
  const first = cache.pick({ key: "a" }, view, copy);
  const changed = cache.pick({ key: "a" }, view, {});
  assert.notEqual(changed, first);
  assert.equal(changed.item, first.item);
  cache.prune(new Set());
  assert.notEqual(cache.pick({ key: "a" }, view, copy).item, first.item);
});
