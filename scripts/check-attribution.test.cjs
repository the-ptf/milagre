const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { attributionLines, findAttribution } = require("./check-attribution.cjs");

const trailer = (who) => `Co-authored-by: ${who}`;
const SCRIPT = path.join(__dirname, "check-attribution.cjs");

test("finds the trailers that reached main after the 2026-10-13 rewrite", () => {
  // Each is a line from a squash commit on main: #932 (46d600e9d), #1028 (b5b12e1ad), #1025 (4ce4bded4).
  const lines = [
    trailer("Claude <noreply@anthropic.com>"),
    trailer("Claude Opus 5.5 <noreply@anthropic.com>"),
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
    trailer("Claude Sonnet 5.5 <noreply@anthropic.com>"),
    trailer("Codex <codex@openai.com>"),
  ];
  for (const line of lines) assert.deepEqual(attributionLines(`fix: something\n\n${line}`), [line], line);
});

test("finds the footers and address-less trailers agents type by hand", () => {
  for (const line of [
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    "Generated with Claude Code",
    trailer("Claude"),
    trailer("Claude Code"),
  ])
    assert.deepEqual(attributionLines(line), [line], line);
});

test("leaves human co-authors and prose about Claude alone", () => {
  const text = [
    "feat: show the Claude account in the usage card",
    "",
    "Claude and Codex Chats both read it. The noreply@anthropic.com address is how the CLI signs in.",
    trailer("Victor Lucas <11355873+victorlucss@users.noreply.github.com>"),
    trailer("Claude Dupont <claude.dupont@example.fr>"),
  ].join("\n");
  assert.deepEqual(attributionLines(text), []);
});

test("names the commit, the AI author and the description line", () => {
  const problems = findAttribution({
    commits: [
      { sha: "46d600e9d0000000", message: `feat: detach\n\n${trailer("Claude <noreply@anthropic.com>")}` },
      { sha: "aaaaaaaaa1111111", message: "fix: web", author: { name: "Claude", email: "noreply@anthropic.com" } },
      { sha: "bbbbbbbbb2222222", message: "fix: clean", author: { name: "Victor Lucas", email: "victor@example.com" } },
    ],
    body: "Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  });
  assert.deepEqual(problems, [
    `commit 46d600e9d: ${trailer("Claude <noreply@anthropic.com>")}`,
    "commit aaaaaaaaa: authored by Claude <noreply@anthropic.com>",
    "PR description: 🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ]);
});

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-attribution-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const run = (args) =>
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd: dir, env, encoding: "utf8" },
    );
  run(["init", "-qb", "main"]);
  run(["commit", "--allow-empty", "-qm", "base"]);
  return { dir, env, run };
}

test("the commit-msg hook and the branch range both fail, and --amend-head fixes the commit", (t) => {
  const { dir, env, run } = repo(t);
  run(["commit", "--allow-empty", "-qm", `fix: thing\n\nBody.\n\n${trailer("Claude Opus 5.5 <noreply@anthropic.com>")}`]);

  const msg = path.join(dir, "MSG");
  fs.writeFileSync(msg, run(["log", "-1", "--format=%B"]));
  const hook = spawnSync(process.execPath, [SCRIPT, "--commit-msg", msg], { cwd: dir, env, encoding: "utf8" });
  assert.equal(hook.status, 1);
  assert.match(hook.stderr, /commit message: Co-authored-by: Claude Opus 5\.5/);
  assert.match(hook.stderr, /--amend-head/);

  const range = spawnSync(process.execPath, [SCRIPT, "main~1..main"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(range.status, 1);
  assert.match(range.stderr, /commit [0-9a-f]{9}: Co-authored-by: Claude Opus 5\.5/);

  const fix = spawnSync(process.execPath, [SCRIPT, "--amend-head"], {
    cwd: dir,
    env: { ...env, GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test" },
    encoding: "utf8",
  });
  assert.equal(fix.status, 0, fix.stderr);
  assert.equal(run(["log", "-1", "--format=%B"]).trim(), "fix: thing\n\nBody.");
  assert.equal(spawnSync(process.execPath, [SCRIPT, "main~1..main"], { cwd: dir, env }).status, 0);
});

test("--amend-head makes you the author of a commit an AI tool authored (#1025's commits were Codex's)", (t) => {
  const { dir, env, run } = repo(t);
  const as = (name, email) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fix: by codex"], {
    cwd: dir,
    env: { ...env, ...as("Codex", "codex@openai.com") },
  });
  const range = spawnSync(process.execPath, [SCRIPT, "main~1..main"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(range.status, 1);
  assert.match(range.stderr, /authored by Codex <codex@openai\.com>/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--amend-head"], { cwd: dir, env: { ...env, ...as("Test", "test@example.test") } }).status, 0);
  assert.equal(run(["log", "-1", "--format=%an <%ae> %s"]).trim(), "Test <test@example.test> fix: by codex");
});

test("lefthook runs it on every commit message and CI runs it on every PR", () => {
  const root = path.join(__dirname, "..");
  assert.match(fs.readFileSync(path.join(root, "lefthook.yml"), "utf8"), /commit-msg:[\s\S]*node scripts\/check-attribution\.cjs --commit-msg \{1\}/);
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/pr-title.yml"), "utf8");
  assert.match(workflow, /node scripts\/check-attribution\.cjs --github-pr/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8")).attribution, { commit: "", pr: "" });
});
