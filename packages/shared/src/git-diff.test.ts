import assert from "node:assert/strict";
import test from "node:test";
import { withHistoryBranches, comparisonBaseMissing, type GitHistory } from "./git-diff.ts";

const data: Extract<GitHistory, { isRepo: true }> = { isRepo: true, branch: "feature", base: "main", commits: [], hasMore: false, branchesVersion: "v1" };
const branches = [{ ref: "refs/heads/main", name: "main" }];

test("omitted catalogues retain only the matching version; legacy hosts still supply full choices", () => {
  assert.deepEqual(withHistoryBranches(data, { version: "v1", branches }), { ...data, branches });
  assert.deepEqual(withHistoryBranches(data, { version: "other", branches }), { ...data, branches: [] });
  assert.deepEqual(withHistoryBranches(data), { ...data, branches: [] });
  const legacy = { ...data, branches, branchesVersion: undefined };
  assert.equal(withHistoryBranches(legacy), legacy);
  const notRepo = { isRepo: false, message: "Not a repository" } as const;
  assert.equal(withHistoryBranches(notRepo, { version: "v1", branches }), notRepo);
});

test("live base checks take precedence over a cached catalogue, with legacy fallback", () => {
  assert.equal(comparisonBaseMissing({ ...data, branches, baseMissing: true }, "refs/heads/main"), true);
  assert.equal(comparisonBaseMissing({ ...data, branches, baseMissing: false }, "refs/heads/just-created"), false);
  assert.equal(comparisonBaseMissing({ ...data, branches }, "refs/heads/deleted"), true);
  assert.equal(comparisonBaseMissing({ ...data, baseMissing: true }, ""), false);
});
