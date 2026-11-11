import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

test("content smoke emulates only reduced-motion forms and keeps other native queries", async () => {
  const calls = [];
  const results = new Map();
  const window = {
    matchMedia(query) {
      const result = { media: query, matches: false, addEventListener() {}, removeEventListener() {} };
      calls.push(query);
      results.set(query, result);
      return result;
    },
  };
  vm.runInNewContext(await readFile(new URL("./renderer/fixture-reduced-motion.js", import.meta.url), "utf8"), { window });
  for (const query of ["(prefers-reduced-motion)", "(prefers-reduced-motion: reduce)"]) {
    const result = window.matchMedia(query);
    assert.equal(result.matches, true);
    assert.equal(result, results.get(query));
    assert.equal(typeof result.addEventListener, "function");
  }
  for (const query of [
    "(prefers-reduced-motion: no-preference)",
    "(prefers-color-scheme: dark)",
    "(max-width: 700px)",
    "screen and (prefers-reduced-motion: reduce)",
  ]) {
    const result = window.matchMedia(query);
    assert.equal(result.matches, false);
    assert.equal(result, results.get(query));
  }
  assert.equal(calls.length, 6);
});
