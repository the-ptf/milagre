// All writes are restricted to a new disposable test repository. No network.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createGit } = require("../../../packages/core/src/git/client.cjs");
const { createGitDiff } = require("../../../packages/core/src/git-diff.cjs");
const { createPullRequestReview } = require("../../../packages/core/src/pull-request-review.cjs");
const root = process.argv[2];
if (!path.isAbsolute(root) || !path.basename(root).startsWith("milagre-pr-read-")) throw new Error("Disposable root required");
const env = {
  ...process.env,
  HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
};
const cwd = path.join(root, "repo");
fs.mkdirSync(cwd);
const git = (...args) =>
  execFileSync(
    "/usr/bin/git",
    ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Synthetic", "-c", "user.email=test@example.invalid", ...args],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const write = (p, text) => fs.writeFileSync(path.join(cwd, p), text);
const commit = (name) => {
  git("add", ".");
  git("commit", "-m", name);
  return git("rev-parse", "HEAD");
};
git("init", "-b", "main");
write("old file", "base\n");
write("deleted", "gone\n");
const base = commit("base");
git("checkout", "-b", "topic");
git("mv", "old file", "new é\nfile");
write("deleted", "gone\n");
fs.unlinkSync(path.join(cwd, "deleted"));
write("binary", Buffer.from([0, 1, 2]));
write("-literal[1].txt", "literal\n");
write("雪.txt", "Unicode 𐀀\n");
write("a\\b", "backslash\n");
const head = commit("topic");
// Dirty working state must never contaminate the immutable PR comparison.
write("雪.txt", "DIRTY\n");
write("untracked", "not part of PR\n");
const client = createGit({ env, analysisOnly: true });
let deniedFetch = 0;
const review = createPullRequestReview({
  env,
  diff: createGitDiff({ env, analysisOnly: true }),
  git: {
    read: client.read,
    write: {
      run: async () => {
        deniedFetch++;
        return { ok: false };
      },
    },
  },
});
const cases = [];
async function add(name, method, request) {
  const expected = await review[method === "pr:diff-files" ? "diffFiles" : "diffFile"](request);
  cases.push({ name, method, args: request, expected });
}
(async () => {
  await add("files", "pr:diff-files", { cwd, base, head });
  for (const file of ["new é\nfile", "deleted", "binary", "-literal[1].txt", "雪.txt", "a\\b"])
    await add(file, "pr:diff-file", { cwd, base, head, path: file, ...(file === "new é\nfile" ? { oldPath: "old file" } : {}) });
  for (const bad of ["-HEAD", "HEAD", head.toUpperCase(), null, 2]) await add("bad-ref-" + bad, "pr:diff-files", { cwd, base: bad, head });
  await add("missing-files", "pr:diff-files", { cwd, base: "1".repeat(40), head });
  await add("missing-patch", "pr:diff-file", { cwd, base, head: "2".repeat(40), path: "雪.txt" });
  for (const file of ["../escape", "/absolute", "a/../bad", "a\\..\\bad", "", "null\0byte"])
    await add("bad-path-" + file, "pr:diff-file", { cwd, base, head, path: file });
  git("checkout", "--orphan", "unrelated");
  git("rm", "-rf", ".");
  write("foreign", "unrelated\n");
  const unrelated = commit("orphan");
  await add("unrelated", "pr:diff-files", { cwd, base, head: unrelated });
  await add("unrelated-patch", "pr:diff-file", { cwd, base, head: unrelated, path: "foreign" });
  console.log(JSON.stringify({ cwd, cases, deniedFetch }));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
