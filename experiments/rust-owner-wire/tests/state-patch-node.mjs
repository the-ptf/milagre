import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { applyStatePatch, diffState } from "../../../packages/shared/src/state-patch.mjs";

// Model immutable shared state: equal Rust subtrees reuse the old JS object.
// Node's independent-clone patches may be larger; their applied results must agree too.
function shared(before, after) {
  if (isDeepStrictEqual(before, after)) return before;
  if (Array.isArray(before) && Array.isArray(after)) return after.map((v, i) => shared(before[i], v));
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    return Object.fromEntries(Object.entries(after).map(([k, v]) => [k, shared(before[k], v)]));
  }
  return after;
}

const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const [index, row] of cases.entries()) {
  const patch = row.changed ? row.patch : undefined;
  const original = JSON.stringify(row.before);
  assert.deepEqual(patch, diffState(row.before, shared(row.before, row.after), row.depth), `patch ${index}`);
  assert.deepEqual(applyStatePatch(row.before, patch), row.after, `Rust patch ${index}`);
  assert.deepEqual(applyStatePatch(row.before, diffState(row.before, row.after, row.depth)), row.after, `Node patch ${index}`);
  assert.equal(JSON.stringify(row.before), original, `mutation ${index}`);
}
console.log(`${cases.length} cases passed against production diffState/applyStatePatch`);
