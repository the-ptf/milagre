import assert from "node:assert/strict";
import test from "node:test";
import { commitComparisonLabel, diffFileCountLabel, withHistoryBranches, comparisonBaseMissing, type GitHistory } from "./git-diff.ts";

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

test("commit labels distinguish the root, a parent, unknown metadata, and truncated counts", () => {
  assert.equal(commitComparisonLabel(null), "First commit");
  assert.equal(commitComparisonLabel("a".repeat(40)), "Compared with first parent");
  assert.equal(commitComparisonLabel(undefined), "Commit changes");
  const files = Array.from({ length: 1000 }, (_, index) => ({ path: String(index), status: "added" as const, added: 1, removed: 0, binary: false }));
  const list = { isRepo: true as const, base: null, files };
  assert.equal(diffFileCountLabel(list), "1000 files");
  assert.equal(diffFileCountLabel({ ...list, truncated: true }), "1000+ files");
  assert.equal(diffFileCountLabel({ ...list, files: [] }), "0 files");
  assert.equal(diffFileCountLabel({ ...list, files: files.slice(0, 1) }), "1 file");
});
