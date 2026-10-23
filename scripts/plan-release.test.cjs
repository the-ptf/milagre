const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { planBeta, planStable, greenCommit, nextDraft, writeNextDraft, classify, line } = require("./plan-release.cjs");

const REPO = "the-ptf/milagre";

// A real git repository; only gh is faked.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-plan-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  const commit = (subject, body) => {
    git("commit", "-q", "--allow-empty", "-m", subject, ...(body ? ["-m", body] : []));
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    return git("rev-parse", "HEAD").trim();
  };
  const tag = (name, ref = "HEAD") => git("tag", name, ref);
  const state = { releases: [], runs: [], installers: [], calls: [] };
  // A published release, as Publish leaves it: a tag and a release.
  const release = (name, ref = "HEAD") => {
    tag(name, ref);
    state.releases.push({ tagName: name, isDraft: false });
  };
  const exec = (command, args) => {
    state.calls.push([command, ...args]);
    if (command === "git") return git(...args);
    if (args[0] === "release" && args[1] === "list") return JSON.stringify(state.releases);
    if (args[0] === "run" && args[1] === "list" && args.includes("package-candidates.yml")) return JSON.stringify(state.installers);
    if (args[0] === "run" && args[1] === "view") {
      const run = state.installers.find((item) => String(item.databaseId) === args[2]);
      return JSON.stringify({ jobs: run.jobs });
    }
    if (args[0] === "run" && args[1] === "list") {
      const at = args.indexOf("--commit");
      const shas = at === -1 ? state.runs : state.runs.filter((sha) => sha === args[at + 1]);
      return JSON.stringify(shas.map((headSha) => ({ headSha })));
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  };
  return { git, commit, tag, release, exec, state };
}
const head = (f) => f.git("rev-parse", "HEAD").trim();
// A package-candidates.yml run on a main push; `failed` names the platforms whose installer check failed.
const installers = (databaseId, headSha, { failed = [], status = "completed", conclusion } = {}) => ({
  databaseId,
  headSha,
  status,
  conclusion: conclusion ?? (status !== "completed" ? "" : failed.length ? "failure" : "success"),
  jobs: ["linux", "macos", "windows"].map((platform) => ({
    name: `package (${platform}, runner, command)`,
    conclusion: failed.includes(platform) ? "failure" : "success",
  })),
});

test("the first beta after a stable bumps by the biggest change and lists every change since stable", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  f.commit("fix(mobile): check indexed reads throughout the app (#531)");
  f.commit("feat: Routines on desktop and phone (#479)");
  f.commit("ci: cache signatures (#518)");
  const plan = planBeta({ exec: f.exec, repo: REPO, sha: head(f) });
  assert.equal(plan.changed, true);
  assert.equal(plan.version, "0.11.0-beta.1");
  assert.equal(plan.releaseTag, "v0.11.0-beta.1");
  assert.equal(plan.base, "0.11.0");
  assert.equal(plan.sha, head(f));
  assert.equal(
    plan.notes,
    [
      "Changes since v0.10.0.",
      "### New\n\n- Routines on desktop and phone ([#479](https://github.com/the-ptf/milagre/pull/479))",
      "### Fixes\n\n- **mobile:** Check indexed reads throughout the app ([#531](https://github.com/the-ptf/milagre/pull/531))",
      "Also 1 maintenance change (CI, tests, refactors, docs).",
      "[Everything since stable v0.10.0](https://github.com/the-ptf/milagre/compare/v0.10.0...v0.11.0-beta.1)",
    ].join("\n\n") + "\n",
  );
});

test("the next beta of a line counts up and its notes start at the previous beta", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  f.commit("feat: first (#1)");
  f.release("v0.11.0-beta.1");
  f.commit("fix: second (#2)");
  const plan = planBeta({ exec: f.exec, repo: REPO, sha: head(f) });
  assert.equal(plan.releaseTag, "v0.11.0-beta.2");
  assert.equal(plan.previous, "v0.11.0-beta.1");
  assert.match(plan.notes, /^Changes since v0\.11\.0-beta\.1\./);
  assert.match(plan.notes, /Second/);
  assert.doesNotMatch(plan.notes, /First/);
});

test("a fix-only line moves up to a minor line when a feature lands", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  f.commit("fix: one (#1)");
  assert.equal(planBeta({ exec: f.exec, repo: REPO, sha: head(f) }).releaseTag, "v0.10.1-beta.1");
  f.release("v0.10.1-beta.1");
  f.commit("feat: two (#2)");
  assert.equal(planBeta({ exec: f.exec, repo: REPO, sha: head(f) }).releaseTag, "v0.11.0-beta.1");
});

test("a breaking change bumps minor on 0.x and major from 1.0", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  f.commit("refactor!: drop the old store (#3)");
  const zero = planBeta({ exec: f.exec, repo: REPO, sha: head(f) });
  assert.equal(zero.releaseTag, "v0.11.0-beta.1");
  assert.match(zero.notes, /### Breaking changes\n\n- Drop the old store/);
  f.commit("fix: footer", "BREAKING CHANGE: the config moved");
  f.release("v1.0.0");
  f.commit("fix: footer again", "BREAKING CHANGE: the config moved again");
  assert.equal(planBeta({ exec: f.exec, repo: REPO, sha: head(f) }).releaseTag, "v2.0.0-beta.1");
});

test("a scheduled beta skips when nothing new or only maintenance landed; a manual one ships maintenance", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  assert.deepEqual(planBeta({ exec: f.exec, repo: REPO, sha: head(f), scheduled: true }), {
    changed: false,
    previous: "v0.10.0",
    reason: "Nothing new since v0.10.0",
  });
  assert.equal(planBeta({ exec: f.exec, repo: REPO, sha: head(f) }).changed, false);
  f.commit("test: steadier check (#4)");
  assert.equal(planBeta({ exec: f.exec, repo: REPO, sha: head(f), scheduled: true }).reason, "Only maintenance changes since v0.10.0");
  const manual = planBeta({ exec: f.exec, repo: REPO, sha: head(f) });
  assert.equal(manual.releaseTag, "v0.10.1-beta.1");
  assert.match(manual.notes, /Also 1 maintenance change/);
});

test("the switch from per-merge tags starts above the beta installs already run", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.203.0");
  f.commit("feat: many merges later (#479)");
  f.tag("v0.228.0"); // a leftover draft candidate's tag
  f.release("v0.228.0-beta.1");
  f.commit("fix: discover models (#533)");
  f.tag("v0.228.1");
  const plan = planBeta({ exec: f.exec, repo: REPO, sha: head(f) });
  assert.equal(plan.releaseTag, "v0.229.0-beta.1");
  assert.match(plan.notes, /^Changes since v0\.228\.0-beta\.1\./);
  assert.doesNotMatch(plan.notes, /Many merges later/);
  assert.match(plan.notes, /compare\/v0\.203\.0\.\.\.v0\.229\.0-beta\.1/);
});

test("after the switch, the next beta continues the line beta installs run instead of jumping past it", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.203.0");
  f.commit("feat: many merges later (#479)");
  f.release("v0.228.0-beta.1");
  f.commit("fix: discover models (#533)");
  f.release("v0.229.0-beta.1");
  f.commit("fix(release): keep the draft's tag (#535)");
  const plan = planBeta({ exec: f.exec, repo: REPO, sha: head(f) });
  assert.equal(plan.releaseTag, "v0.229.0-beta.2");
  assert.match(plan.notes, /^Changes since v0\.229\.0-beta\.1\./);
  f.release("v0.229.0-beta.2");
  f.release("v0.229.0");
  f.commit("fix: after the promotion (#536)");
  assert.equal(planBeta({ exec: f.exec, repo: REPO, sha: head(f) }).releaseTag, "v0.229.1-beta.1");
});

test("drafts and the Next beta draft never count as releases", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  f.commit("feat: one (#1)");
  f.state.releases.push({ tagName: "v0.12.0", isDraft: true }, { tagName: "next-beta", isDraft: true });
  assert.equal(planBeta({ exec: f.exec, repo: REPO, sha: head(f) }).releaseTag, "v0.11.0-beta.1");
});

test("a line whose stable tag already exists fails instead of shipping a beta that could never be promoted", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  f.commit("feat: one (#1)");
  f.tag("v0.11.0");
  assert.throws(() => planBeta({ exec: f.exec, repo: REPO, sha: head(f) }), /Tag v0\.11\.0 already exists/);
});

test("a beta must come from a descendant of the previous release", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  const root = head(f);
  f.commit("feat: released (#1)");
  f.release("v0.10.0");
  assert.throws(() => planBeta({ exec: f.exec, repo: REPO, sha: root }), /v0\.10\.0 is not an ancestor/);
});

test("stable promotes the newest beta's commit with every change since the previous stable", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  f.commit("fix: one (#1)");
  f.release("v0.10.1-beta.1");
  f.commit("feat: two (#2)");
  f.release("v0.11.0-beta.1");
  f.commit("perf: three (#3)");
  f.release("v0.11.0-beta.2");
  const promoted = head(f);
  f.commit("feat: after the beta (#4)");
  const plan = planStable({ exec: f.exec, repo: REPO });
  assert.equal(plan.sha, promoted);
  assert.equal(plan.version, "0.11.0");
  assert.equal(plan.releaseTag, "v0.11.0");
  assert.equal(
    plan.notes,
    [
      "Everything since v0.10.0: 1 new, 1 fix, 1 faster. Betas: v0.10.1-beta.1, v0.11.0-beta.1, v0.11.0-beta.2.",
      "### New\n\n- Two ([#2](https://github.com/the-ptf/milagre/pull/2))",
      "### Fixes\n\n- One ([#1](https://github.com/the-ptf/milagre/pull/1))",
      "### Faster\n\n- Three ([#3](https://github.com/the-ptf/milagre/pull/3))",
      "[Full diff](https://github.com/the-ptf/milagre/compare/v0.10.0...v0.11.0)",
    ].join("\n\n") + "\n",
  );
  assert.equal(planStable({ exec: f.exec, repo: REPO, requested: "v0.11.0-beta.2" }).releaseTag, "v0.11.0");
});

test("stable refuses an older beta, a missing beta and a taken tag", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  assert.throws(() => planStable({ exec: f.exec, repo: REPO }), /No beta is newer than the published v0\.10\.0/);
  f.commit("feat: one (#1)");
  f.release("v0.11.0-beta.1");
  f.commit("fix: two (#2)");
  f.release("v0.11.0-beta.2");
  assert.throws(() => planStable({ exec: f.exec, repo: REPO, requested: "v0.11.0-beta.1" }), /not the newest beta \(v0\.11\.0-beta\.2\)/);
  f.tag("v0.11.0", "HEAD~1");
  assert.throws(() => planStable({ exec: f.exec, repo: REPO }), /Tag v0\.11\.0 already exists/);
});

test("betas of an already promoted line are not promoted again", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  f.commit("feat: one (#1)");
  f.release("v0.11.0-beta.1");
  f.release("v0.11.0");
  assert.throws(() => planStable({ exec: f.exec, repo: REPO }), /No beta is newer than the published v0\.11\.0/);
  f.commit("fix: two (#2)");
  const plan = planBeta({ exec: f.exec, repo: REPO, sha: head(f) });
  assert.equal(plan.releaseTag, "v0.11.1-beta.1");
  assert.match(plan.notes, /^Changes since v0\.11\.0\./);
});

test("a beta ships the newest green main commit, or a requested one that is on main and passed CI", (t) => {
  const f = fixture(t);
  const first = f.commit("feat: initial");
  const second = f.commit("feat: next");
  f.state.runs = [first];
  f.state.installers = [installers(1, first)];
  assert.equal(greenCommit({ exec: f.exec }), first);
  assert.equal(greenCommit({ exec: f.exec, requested: first }), first);
  assert.throws(() => greenCommit({ exec: f.exec, requested: second }), /CI has not passed on/);
  f.git("checkout", "-q", "-b", "side", first);
  f.git("commit", "-q", "--allow-empty", "-m", "fix: off main");
  const side = head(f);
  f.state.runs = [side];
  assert.throws(() => greenCommit({ exec: f.exec, requested: side }), /is not on main/);
  f.state.runs = [];
  assert.throws(() => greenCommit({ exec: f.exec }), /No main commit has passed CI/);
});

test("a beta skips main commits whose macOS or Linux installer check failed, ran on an older commit or was cancelled", (t) => {
  const f = fixture(t);
  const good = f.commit("feat: initial");
  const broken = f.commit("feat: headless CLI");
  const docs = f.commit("docs: no app change");
  f.state.runs = [docs, broken, good];
  // The docs commit touched no app path, so the check on the broken commit below it is the one that tested its tree.
  f.state.installers = [installers(2, broken, { failed: ["macos"] }), installers(1, good, { failed: ["windows"] })];
  assert.equal(greenCommit({ exec: f.exec }), good, "a failed Windows check doesn't hold a beta back");
  assert.throws(() => greenCommit({ exec: f.exec, requested: docs }), /can't ship: the macos installer check failed on/);
  assert.throws(() => greenCommit({ exec: f.exec, requested: broken }), /can't ship: the macos installer check failed on/);
  const fixed = f.commit("fix: keychain");
  f.state.runs = [fixed, docs, broken, good];
  f.state.installers.unshift(installers(3, fixed, { status: "in_progress" }));
  assert.throws(() => greenCommit({ exec: f.exec, requested: fixed }), /still running/);
  assert.equal(greenCommit({ exec: f.exec }), good);
  f.state.installers[0] = installers(3, fixed, { conclusion: "cancelled" });
  assert.throws(() => greenCommit({ exec: f.exec, requested: fixed }), /cancelled/);
  f.state.installers[0] = installers(3, fixed, { failed: ["linux"] });
  assert.throws(() => greenCommit({ exec: f.exec, requested: fixed }), /the linux installer check failed/);
  f.state.installers[0] = installers(3, fixed);
  assert.equal(greenCommit({ exec: f.exec }), fixed);
  f.state.installers = [installers(2, broken, { failed: ["macos", "linux"] })];
  assert.throws(() => greenCommit({ exec: f.exec }), /No CI-green main commit passed its installer checks[\s\S]*no installer check has run on it/);
});

test("release lines link the PR, show the scope and capitalize prose only", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const entry = (subject) => line(classify({ sha, subject, body: "" }), REPO);
  assert.equal(
    entry("feat(mcp): worktree_remove for done Worktrees (#507)"),
    "- **mcp:** worktree_remove for done Worktrees ([#507](https://github.com/the-ptf/milagre/pull/507))",
  );
  assert.equal(
    entry("fix: a resent message never runs twice (#487)"),
    "- A resent message never runs twice ([#487](https://github.com/the-ptf/milagre/pull/487))",
  );
  assert.equal(entry("fix: direct push"), "- Direct push ([0123456](https://github.com/the-ptf/milagre/commit/0123456789abcdef0123456789abcdef01234567))");
  assert.equal(classify({ sha, subject: 'Revert "feat: x"', body: "" }).level, null);
});

test("the Next beta draft names the version a cut would take, or says nothing is pending", (t) => {
  const f = fixture(t);
  f.commit("feat: initial");
  f.release("v0.10.0");
  assert.deepEqual(nextDraft(planBeta({ exec: f.exec, repo: REPO, sha: head(f) })), {
    title: "Next beta: nothing yet",
    body: "Nothing merged to main since v0.10.0.\n",
  });
  f.commit("feat: one (#1)");
  const draft = nextDraft(planBeta({ exec: f.exec, repo: REPO, sha: head(f) }));
  assert.equal(draft.title, "Next beta: v0.11.0-beta.1");
  assert.match(draft.body, /^Merged to main since v0\.10\.0, not yet in a beta\. A beta cut now would be v0\.11\.0-beta\.1\./);
  assert.match(draft.body, /\n\n### New\n\n- One/);
});

test("the Next beta draft is created once and rewritten after that", () => {
  const calls = [];
  let existing = "";
  const exec = (command, args) => {
    calls.push(args);
    if (args.includes("--paginate")) return existing;
    const body = args.find((arg) => arg.startsWith("body=@"));
    assert.equal(fs.readFileSync(body.slice("body=@".length), "utf8"), "notes\n");
    return "{}";
  };
  writeNextDraft({ exec, title: "Next beta: v0.11.0-beta.1", body: "notes\n" });
  assert.deepEqual(calls[1].slice(0, 7), ["api", "-X", "POST", "repos/{owner}/{repo}/releases", "-f", "tag_name=next-beta", "-f"]);
  assert.ok(calls[1].includes("draft=true"));
  existing = "42\n";
  writeNextDraft({ exec, title: "Next beta: v0.11.0-beta.1", body: "notes\n" });
  // An update without tag_name turns a tagless draft into "untagged-<random>", so every update sends it.
  assert.deepEqual(calls[3].slice(0, 8), [
    "api",
    "-X",
    "PATCH",
    "repos/{owner}/{repo}/releases/42",
    "-f",
    "tag_name=next-beta",
    "-f",
    "name=Next beta: v0.11.0-beta.1",
  ]);
});

test("the Next beta draft is found by its tag or, once GitHub untagged it, by its title", { skip: !jqAvailable() && "jq is not installed" }, () => {
  let query;
  const exec = (command, args) => {
    if (args.includes("--paginate")) query = args[args.indexOf("--jq") + 1];
    return "";
  };
  writeNextDraft({ exec, title: "Next beta: nothing yet", body: "notes\n" });
  const releases = [
    { id: 1, draft: false, tag_name: "v0.229.0-beta.1", name: "v0.229.0-beta.1" },
    { id: 2, draft: true, tag_name: "untagged-51d2daee17841470cabf", name: "Next beta: nothing yet" },
    { id: 3, draft: true, tag_name: "next-beta", name: null },
    { id: 4, draft: true, tag_name: "v0.300.0", name: "Some other draft" },
    { id: 5, draft: false, tag_name: "next-beta", name: "Next beta: published by mistake" },
  ];
  const ids = execFileSync("jq", [query], { input: JSON.stringify(releases), encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(ids, ["2", "3"]);
});

function jqAvailable() {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
