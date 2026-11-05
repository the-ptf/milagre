const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { BRANCH_POLICY_DEFAULTS, formatPolicyBranch, validateBranchPolicy, branchTicket } = require("@milagre/shared/branch-policy");
const { resolveBranchPolicy, availablePolicyBranch, branchPolicyNote } = require("./branch-policy.cjs");
const { createWorktree, renameWorktreeBranch } = require("./worktrees.cjs");
const { createProjectSettings } = require("./project-settings.cjs");

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-branch-policy-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const git = (...args) =>
    execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("commit", "--allow-empty", "-m", "Initial");
  await fs.mkdir(path.join(project, ".milagre"));
  return { root, project, git, policyFile: path.join(project, ".milagre/worktree.json") };
}

const arketa = {
  ...BRANCH_POLICY_DEFAULTS,
  template: "{username}-{ticket?}-{slug}",
  username: "victorlucss",
  dashesOnly: true,
  baseBranch: "release/business-app/v2",
};

test("templates keep Arketa names valid, omit optional tickets, and never rewrite slash-containing bases", () => {
  assert.equal(
    formatPolicyBranch(validateBranchPolicy(arketa), { slug: "Fix the Login", ticket: "ARK-123", suffix: "ab12" }),
    "victorlucss-ark-123-fix-the-login",
  );
  assert.equal(formatPolicyBranch(arketa, { slug: "Fix the Login", suffix: "ab12" }), "victorlucss-fix-the-login");
  assert.equal(formatPolicyBranch(arketa, { slug: "ARK-123 fix login", ticket: "ARK-123", suffix: "ab12" }), "victorlucss-ark-123-fix-login");
  assert.equal(arketa.baseBranch, "release/business-app/v2");
  assert.throws(() => validateBranchPolicy({ ...arketa, template: "milagre/{slug}" }), /dashes only/);
  assert.throws(() => validateBranchPolicy({ ...arketa, template: "{unknown}-{slug}" }), /may only use/);
  assert.throws(() => validateBranchPolicy({ ...arketa, baseBranch: "--detach" }), /base branch/);
  assert.throws(() => formatPolicyBranch({ ...arketa, template: "{username}-{ticket}-{slug}" }, { slug: "fix", suffix: "a" }), /needs a ticket/);
  assert.equal(branchTicket("Fix ARK-123 and discuss ARK-123"), "ARK-123");
  assert.equal(branchTicket("Compare ARK-123 and ARK-456"), "");
  assert.equal(branchTicket("No ticket"), "");
});

test("Project settings survive restarts and repository fields override only their own fields", async (t) => {
  const f = await fixture(t);
  const storeFile = path.join(f.root, "profile/settings.json");
  const store = createProjectSettings(storeFile);
  await store.setGit(f.project, { template: "mine-{slug}", username: "victorlucss", instructions: "Use a short verb." });
  await fs.writeFile(f.policyFile, JSON.stringify({ setup: "npm ci", git: { template: "{username}-{ticket?}-{slug}", dashesOnly: true } }));
  const result = await resolveBranchPolicy(f.project, await createProjectSettings(storeFile).getGit(f.project));
  assert.equal(result.effective.username, "victorlucss");
  assert.equal(result.effective.template, "{username}-{ticket?}-{slug}");
  assert.equal(result.local.template, "mine-{slug}");
  assert.match(branchPolicyNote(f.project, result.effective), /Use a short verb/);
  await store.setGit(f.project, {});
  assert.deepEqual(await store.getGit(f.project), {});
  await fs.writeFile(f.policyFile, '{"git":');
  await assert.rejects(resolveBranchPolicy(f.project), /Fix .milagre\/worktree.json/);
  await fs.writeFile(f.policyFile, JSON.stringify({ git: { trackBase: "false" } }));
  await assert.rejects(resolveBranchPolicy(f.project), /true or false/);
});

test("a remote collision gets a suffix and a second collision fails without taking an existing branch", async (t) => {
  const f = await fixture(t);
  const input = { slug: "fix-login", ticket: "ARK-123", suffix: "ab12" };
  const expected = "victorlucss-ark-123-fix-login";
  f.git("update-ref", `refs/remotes/origin/${expected}`, "HEAD");
  assert.equal(await availablePolicyBranch(f.project, arketa, input), `${expected}-ab12`);
  f.git("branch", `${expected}-ab12`);
  await assert.rejects(availablePolicyBranch(f.project, arketa, input), /already exists/);
  assert.equal(await availablePolicyBranch(f.project, BRANCH_POLICY_DEFAULTS, input, { issueBranch: "matt/ark-123-fix-login" }), "matt/ark-123-fix-login");
  assert.match(
    await availablePolicyBranch(f.project, { ...BRANCH_POLICY_DEFAULTS, dashesOnly: true }, input, { issueBranch: "matt/ark-123-fix-login" }),
    /^ark-123-fix-login$/,
  );
});

test("a configured Worktree starts at the requested release, has no upstream, and its automatic rename retains the policy", async (t) => {
  const f = await fixture(t);
  f.git("branch", arketa.baseBranch);
  const branch = await availablePolicyBranch(f.project, arketa, { slug: "ARK-123 handle login", ticket: "ARK-123", suffix: "ab12" });
  const created = await createWorktree({ projectPath: f.project, baseBranch: arketa.baseBranch, branch, suffix: "ab12", root: path.join(f.root, "worktrees") });
  assert.equal(f.git("rev-parse", created.branch), f.git("rev-parse", arketa.baseBranch));
  assert.throws(() => f.git("rev-parse", `${created.branch}@{u}`));
  const renamed = await renameWorktreeBranch({ worktreePath: created.path, branch, policy: arketa, suffix: "ab12", ticket: "ARK-123", slug: "fix-login" });
  assert.equal(renamed, "victorlucss-ark-123-fix-login");
  assert.ok((await fs.stat(created.path)).isDirectory());
  f.git("update-ref", `refs/remotes/origin/${renamed}`, renamed);
  assert.equal(
    await renameWorktreeBranch({ worktreePath: created.path, branch: renamed, policy: arketa, suffix: "ab12", ticket: "ARK-123", slug: "another-name" }),
    null,
  );
});

test("tracking is explicit even when Git's global autoSetupMerge says otherwise", async (t) => {
  const f = await fixture(t);
  f.git("config", "branch.autoSetupMerge", "always");
  const first = await createWorktree({ projectPath: f.project, baseBranch: "main", prompt: "no tracking", suffix: "a1", root: path.join(f.root, "worktrees") });
  assert.throws(() => f.git("rev-parse", `${first.branch}@{u}`));
  const second = await createWorktree({
    projectPath: f.project,
    baseBranch: "main",
    trackBase: true,
    prompt: "tracking",
    suffix: "b2",
    root: path.join(f.root, "worktrees"),
  });
  assert.equal(f.git("rev-parse", "--abbrev-ref", `${second.branch}@{u}`), "main");
});
