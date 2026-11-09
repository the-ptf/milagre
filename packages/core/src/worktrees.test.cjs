const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createWorktree, issueBranch, listBranches, renameWorktreeBranch, slugify } = require("./worktrees.cjs");
const { COPY_LIMITS, EXCLUDED_FOLDERS, previewFilesToCopy } = require("./worktree-files.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-worktrees-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "shop");
  await fs.mkdir(project);
  const git = (...args) =>
    execFileSync("git", ["-C", project, "-c", "user.name=Milagre", "-c", "user.email=milagre@example.com", ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  await fs.writeFile(path.join(project, "README.md"), "shop\n");
  git("add", ".");
  git("commit", "-m", "init");
  git("branch", "release/v2");
  return { root, project, git };
}

test("slugify keeps the first words of a prompt as a branch-safe name", () => {
  assert.equal(slugify("Fix the login redirect, please!"), "fix-the-login-redirect-please");
  assert.equal(slugify("Corrija a navegação do menu lateral agora mesmo"), "corrija-a-navegacao-do-menu");
  assert.equal(slugify("   ?!  "), "");
});

test("listBranches returns local branches and nothing outside a repository", async (t) => {
  const { root, project } = await fixture(t);
  assert.deepEqual((await listBranches(project)).sort(), ["main", "release/v2"]);
  assert.deepEqual(await listBranches(root), []);
});

test("createWorktree branches from the base outside the project", async (t) => {
  const { root, project, git } = await fixture(t);
  const worktreeRoot = path.join(root, "worktrees");
  const created = await createWorktree({ projectPath: project, baseBranch: "release/v2", prompt: "Add a checkout page", root: worktreeRoot, suffix: "ab12" });

  assert.deepEqual(created, {
    branch: "milagre/add-a-checkout-page-ab12",
    path: path.join(worktreeRoot, "shop", "add-a-checkout-page-ab12"),
    base: "release/v2",
  });
  assert.equal(await fs.readFile(path.join(created.path, "README.md"), "utf8"), "shop\n");
  assert.match(git("worktree", "list", "--porcelain"), /branch refs\/heads\/milagre\/add-a-checkout-page-ab12/);
  assert.equal(git("rev-parse", created.branch).trim(), git("rev-parse", "release/v2").trim());
});

test("createWorktree falls back to a generic name and reports git errors", async (t) => {
  const { root, project } = await fixture(t);
  const worktreeRoot = path.join(root, "worktrees");
  const created = await createWorktree({ projectPath: project, baseBranch: "main", prompt: "", root: worktreeRoot, suffix: "zz99" });
  assert.equal(created.branch, "milagre/chat-zz99");
  await assert.rejects(createWorktree({ projectPath: project, baseBranch: "missing", prompt: "x", root: worktreeRoot, suffix: "q1" }), /missing/);
});

test("createWorktree refuses a base that is not an existing ref, so it can never pass git an option", async (t) => {
  const { root, project, git } = await fixture(t);
  const worktreeRoot = path.join(root, "worktrees");
  for (const baseBranch of ["--lock", "--no-checkout", "-b", "--detach", "", "main\n--lock", 42, null]) {
    await assert.rejects(
      createWorktree({ projectPath: project, baseBranch, prompt: "x", root: worktreeRoot, suffix: "op1" }),
      /missing from this project/,
      String(baseBranch),
    );
  }
  assert.doesNotMatch(git("worktree", "list", "--porcelain"), /milagre\/x-op1|locked/);
  await assert.rejects(fs.stat(worktreeRoot), { code: "ENOENT" });
  // A tag or a commit still works: any existing ref, as resolveBase allows.
  const commit = git("rev-parse", "HEAD").trim();
  assert.equal((await createWorktree({ projectPath: project, baseBranch: commit, prompt: "x", root: worktreeRoot, suffix: "ok1" })).base, commit);
});

test("renameWorktreeBranch renames a running worktree's branch and keeps its folder", async (t) => {
  const { root, project, git } = await fixture(t);
  const created = await createWorktree({
    projectPath: project,
    baseBranch: "main",
    prompt: "the sidebar thing is broken",
    root: path.join(root, "worktrees"),
    suffix: "ef56",
  });

  assert.equal(
    await renameWorktreeBranch({ worktreePath: created.path, branch: created.branch, slug: "Fix sidebar collapse" }),
    "milagre/fix-sidebar-collapse-ef56",
  );
  assert.equal(execFileSync("git", ["-C", created.path, "branch", "--show-current"], { encoding: "utf8" }).trim(), "milagre/fix-sidebar-collapse-ef56");
  assert.match(
    git("worktree", "list", "--porcelain"),
    /the-sidebar-thing-is-broken-ef56\nHEAD [0-9a-f]+\nbranch refs\/heads\/milagre\/fix-sidebar-collapse-ef56/,
  );

  // Nothing to do, or the old branch is already gone.
  assert.equal(await renameWorktreeBranch({ worktreePath: created.path, branch: "milagre/fix-sidebar-collapse-ef56", slug: "fix-sidebar-collapse" }), null);
  assert.equal(await renameWorktreeBranch({ worktreePath: created.path, branch: "milagre/fix-sidebar-collapse-ef56", slug: "" }), null);
  assert.equal(await renameWorktreeBranch({ worktreePath: created.path, branch: created.branch, slug: "other-name" }), null);
});

// A project cloned from a remote whose main has since moved on; the local main is one commit behind.
async function trailingClone(t) {
  const { root, project: remote, git: remoteGit } = await fixture(t);
  const project = path.join(root, "clone");
  execFileSync("git", ["clone", "--quiet", remote, project]);
  const git = (...args) =>
    execFileSync("git", ["-C", project, "-c", "user.name=Milagre", "-c", "user.email=milagre@example.com", ...args], { encoding: "utf8" });
  await fs.writeFile(path.join(remote, "NEWS.md"), "shipped\n");
  remoteGit("add", ".");
  remoteGit("commit", "-m", "ship");
  return { root, project, git, remote, remoteGit };
}

test("createWorktree starts a trailing branch from its freshly fetched upstream", async (t) => {
  const { root, project, git, remoteGit } = await trailingClone(t);
  const created = await createWorktree({ projectPath: project, baseBranch: "main", prompt: "x", root: path.join(root, "worktrees"), suffix: "up1" });
  assert.equal(git("rev-parse", created.branch).trim(), remoteGit("rev-parse", "main").trim());
  assert.equal(await fs.readFile(path.join(created.path, "NEWS.md"), "utf8"), "shipped\n");
  // The chat's branch doesn't track the branch it started from.
  assert.throws(() => git("rev-parse", "--abbrev-ref", `${created.branch}@{upstream}`));
});

test("createWorktree keeps a branch's own unpushed commits", async (t) => {
  const { root, project, git } = await trailingClone(t);
  await fs.writeFile(path.join(project, "LOCAL.md"), "mine\n");
  git("add", ".");
  git("commit", "-m", "local");
  const created = await createWorktree({ projectPath: project, baseBranch: "main", prompt: "x", root: path.join(root, "worktrees"), suffix: "lo1" });
  assert.equal(git("rev-parse", created.branch).trim(), git("rev-parse", "main").trim());
});

test("createWorktree starts from the local branch when the remote can't be reached", async (t) => {
  const { root, project, git, remote } = await trailingClone(t);
  await fs.rm(remote, { recursive: true, force: true });
  const created = await createWorktree({ projectPath: project, baseBranch: "main", prompt: "x", root: path.join(root, "worktrees"), suffix: "off1" });
  assert.equal(git("rev-parse", created.branch).trim(), git("rev-parse", "main").trim());
});

// A project whose .gitignore covers env files and secrets, with a tracked .env.example.
async function ignoredFixture(t, files = {}) {
  const { root, project, git } = await fixture(t);
  await fs.writeFile(path.join(project, ".gitignore"), ".env*\nsecrets/\n*.log\n");
  await fs.writeFile(path.join(project, ".env.example"), "KEY=from-git\n");
  git("add", ".gitignore");
  git("add", "-f", ".env.example");
  git("commit", "-m", "ignore");
  await fs.writeFile(path.join(project, ".env"), "KEY=secret\n");
  await fs.writeFile(path.join(project, ".env.local"), "KEY=local\n");
  // A tracked file is never copied, even when it changed in the main checkout.
  await fs.writeFile(path.join(project, ".env.example"), "KEY=edited-in-main\n");
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(project, name)), { recursive: true });
    await fs.writeFile(path.join(project, name), contents);
  }
  return { root, project, git, worktreeRoot: path.join(root, "worktrees") };
}

const create = (fx, extra = {}) => createWorktree({ projectPath: fx.project, baseBranch: "main", prompt: "x", root: fx.worktreeRoot, suffix: "cp1", ...extra });
const exists = (file) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  );

test("the default pattern copies ignored env files but not a tracked one", async (t) => {
  const fx = await ignoredFixture(t);
  const created = await create(fx);
  assert.equal(await fs.readFile(path.join(created.path, ".env"), "utf8"), "KEY=secret\n");
  assert.equal(await fs.readFile(path.join(created.path, ".env.local"), "utf8"), "KEY=local\n");
  assert.equal(await fs.readFile(path.join(created.path, ".env.example"), "utf8"), "KEY=from-git\n");
  assert.deepEqual([...created.copy.copied].sort(), [".env", ".env.local"]);
});

test("custom patterns replace the default", async (t) => {
  const fx = await ignoredFixture(t, { "secrets/a.json": "{}", "secrets/b.txt": "x" });
  const created = await create(fx, { copyPatterns: ["secrets/*.json"] });
  assert.equal(await exists(path.join(created.path, "secrets/a.json")), true);
  assert.equal(await exists(path.join(created.path, "secrets/b.txt")), false);
  assert.equal(await exists(path.join(created.path, ".env")), false);
});

test("broad extra-file copy patterns skip ignored Milagre state while Git carries shared configuration", async (t) => {
  const fx = await ignoredFixture(t, {
    ".milagre/chats.db": "local database",
    ".milagre/coordination.json": "{}",
    ".milagre/details/local.json": "{}",
    ".milagre/worktree.json": "{}",
    "secrets/shared.json": '{"keep":true}',
  });
  require("./project-ignore.cjs").ensureProjectIgnore(fx.project);
  fx.git("add", ".milagre/worktree.json");
  fx.git("commit", "-m", "Shared setup");
  await fs.writeFile(path.join(fx.project, ".worktreeinclude"), "*.json\n*.db\n");
  const created = await create(fx);
  assert.deepEqual(created.copy.copied, ["secrets/shared.json"]);
  assert.equal(await fs.readFile(path.join(created.path, ".milagre/worktree.json"), "utf8"), "{}");
  assert.equal(await exists(path.join(created.path, ".milagre/chats.db")), false);
  assert.equal(await exists(path.join(created.path, ".milagre/coordination.json")), false);
});

test(".worktreeinclude wins over the setting", async (t) => {
  const fx = await ignoredFixture(t, { "secrets/a.json": "{}" });
  await fs.writeFile(path.join(fx.project, ".worktreeinclude"), "# only the local env\n.env.local\n");
  const created = await create(fx, { copyPatterns: ["secrets/*.json"] });
  assert.deepEqual(created.copy.copied, [".env.local"]);
  assert.equal(await exists(path.join(created.path, ".env")), false);
  assert.equal(await exists(path.join(created.path, "secrets/a.json")), false);
});

test("negation keeps a file out", async (t) => {
  const fx = await ignoredFixture(t);
  const created = await create(fx, { copyPatterns: [".env*", "!.env.local"] });
  assert.deepEqual(created.copy.copied, [".env"]);
});

test("nested paths are kept with their folders", async (t) => {
  const fx = await ignoredFixture(t, { "apps/web/.env": "WEB=1\n", "apps/web/deep/.env.local": "DEEP=1\n" });
  const created = await create(fx);
  assert.equal(await fs.readFile(path.join(created.path, "apps/web/.env"), "utf8"), "WEB=1\n");
  assert.equal(await fs.readFile(path.join(created.path, "apps/web/deep/.env.local"), "utf8"), "DEEP=1\n");
});

test("a matching file git does not ignore is not copied", async (t) => {
  const fx = await ignoredFixture(t, { "notes.env": "not ignored\n" });
  const created = await create(fx, { copyPatterns: ["*.env", ".env"] });
  assert.deepEqual(created.copy.copied, [".env"]);
  assert.equal(await exists(path.join(created.path, "notes.env")), false);
});

test("symlinks are skipped", async (t) => {
  const fx = await ignoredFixture(t);
  await fs.symlink(path.join(fx.project, ".env"), path.join(fx.project, ".env.link"));
  const created = await create(fx);
  assert.equal(await exists(path.join(created.path, ".env.link")), false);
  assert.deepEqual([...created.copy.copied].sort(), [".env", ".env.local"]);
});

test("the copy stops at the file cap and says so", async (t) => {
  const fx = await ignoredFixture(t);
  const created = await create(fx, { copyLimits: { maxFiles: 1 } });
  assert.equal(created.copy.copied.length, 1);
  assert.match(created.copy.notes.join("\n"), /1 file/);
});

test("the copy stops at the size cap", async (t) => {
  const fx = await ignoredFixture(t, { ".env.big": "x".repeat(2000) });
  const created = await create(fx, { copyLimits: { maxBytes: 1000 } });
  assert.equal(await exists(path.join(created.path, ".env.big")), false);
  assert.ok(created.copy.notes.length > 0);
});

test("the default cap is 500 files and 100 MB", () => {
  assert.deepEqual(COPY_LIMITS, { maxFiles: 500, maxBytes: 100 * 1024 * 1024 });
});

test("a copy that fails does not fail the worktree", async (t) => {
  const fx = await ignoredFixture(t);
  await fs.chmod(path.join(fx.project, ".env.local"), 0o000);
  t.after(() => fs.chmod(path.join(fx.project, ".env.local"), 0o600).catch(() => {}));
  const created = await create(fx);
  assert.equal(await exists(path.join(created.path, ".env")), true);
  assert.equal(await exists(path.join(created.path, ".env.local")), false);
  assert.match(created.copy.notes.join("\n"), /\.env\.local/);
});

test("a worktree with nothing to copy returns the plain result", async (t) => {
  const { root, project } = await fixture(t);
  const created = await createWorktree({ projectPath: project, baseBranch: "main", prompt: "x", root: path.join(root, "worktrees"), suffix: "np1" });
  assert.equal("copy" in created, false);
});

test("dependency and build folders are skipped by the default and by unanchored patterns", async (t) => {
  const fx = await ignoredFixture(t, {
    "node_modules/pkg/.env": "DEP=1\n",
    "apps/web/node_modules/pkg/.env": "DEP=2\n",
    "dist/.env": "BUILD=1\n",
    ".venv/lib/.env": "PY=1\n",
    "vendor/bundle/gem/.env": "RB=1\n",
  });
  const created = await create(fx);
  assert.deepEqual([...created.copy.copied].sort(), [".env", ".env.local"]);
  assert.deepEqual((await previewFilesToCopy(fx.project, undefined)).matches, [".env", ".env.local"]);
  assert.deepEqual((await previewFilesToCopy(fx.project, [".env*", "!.env.local"])).matches, [".env"]);
});

test("an anchored pattern can still ask for a file inside an excluded folder", async (t) => {
  const fx = await ignoredFixture(t, {
    "dist/config.json": "{}",
    "dist/other.json": "{}",
    "node_modules/pkg/.env": "DEP=1\n",
    "vendor/bundle/gem/.env": "RB=1\n",
  });
  await fs.appendFile(path.join(fx.project, ".gitignore"), "dist/\n*.json\n");
  const created = await create(fx, { copyPatterns: ["dist/config.json", "vendor/bundle/gem/.env"] });
  assert.deepEqual([...created.copy.copied].sort(), ["dist/config.json", "vendor/bundle/gem/.env"]);
  await fs.writeFile(path.join(fx.project, ".worktreeinclude"), "/node_modules/pkg/.env\n");
  assert.deepEqual((await previewFilesToCopy(fx.project, undefined)).matches, ["node_modules/pkg/.env"]);
});

test("a negated pattern never lifts an exclusion, and more build folders are skipped", async (t) => {
  const fx = await ignoredFixture(t, {
    "node_modules/p1/.env": "1",
    "node_modules/p2/.env": "2",
    "Pods/x/.env": "3",
    ".gradle/.env": "4",
    ".expo/.env": "5",
    ".dart_tool/.env": "6",
    "coverage/.env": "7",
  });
  assert.deepEqual((await previewFilesToCopy(fx.project, [".env*", "!node_modules/p1/.env"])).matches, [".env", ".env.local"]);
  assert.deepEqual(EXCLUDED_FOLDERS.filter((folder) => ["Pods", ".gradle", ".expo", ".dart_tool", "coverage"].includes(folder)).length, 5);
  assert.deepEqual((await previewFilesToCopy(fx.project, undefined)).matches, [".env", ".env.local"]);
});

test("the copy does not follow a folder the base branch tracks as a symlink out of the worktree", async (t) => {
  const fx = await ignoredFixture(t);
  fx.git("checkout", "-q", "-b", "linky");
  await fs.symlink("../outside", path.join(fx.project, "cfg"));
  fx.git("add", "cfg");
  fx.git("commit", "-m", "link");
  fx.git("checkout", "-q", "main");
  await fs.mkdir(path.join(fx.project, "cfg", "deep"), { recursive: true });
  await fs.writeFile(path.join(fx.project, "cfg", ".env"), "SECRET=1\n");
  await fs.writeFile(path.join(fx.project, "cfg", "deep", ".env"), "SECRET=2\n");
  const created = await create(fx, { baseBranch: "linky" });
  const outside = path.join(fx.worktreeRoot, "shop", "outside");
  assert.equal(await exists(outside), false);
  assert.equal(await exists(path.join(outside, ".env")), false);
  assert.deepEqual([...created.copy.copied].sort(), [".env", ".env.local"]);
  assert.match(created.copy.notes.join("\n"), /cfg\/\.env/);
});

test("a file the base branch tracks is left as git has it", async (t) => {
  const fx = await ignoredFixture(t);
  fx.git("checkout", "-q", "-b", "tracks-env");
  await fs.writeFile(path.join(fx.project, ".env"), "FROM=branch\n");
  fx.git("add", "-f", ".env");
  fx.git("commit", "-m", "track env");
  fx.git("checkout", "-q", "main");
  await fs.writeFile(path.join(fx.project, ".env"), "FROM=main-ignored\n");
  const created = await create(fx, { baseBranch: "tracks-env" });
  assert.equal(await fs.readFile(path.join(created.path, ".env"), "utf8"), "FROM=branch\n");
  assert.deepEqual(created.copy.copied, [".env.local"]);
  assert.deepEqual(created.copy.notes, []);
});

test("previewFilesToCopy lists what the effective patterns match", async (t) => {
  const fx = await ignoredFixture(t, { "apps/web/.env": "1" });
  const found = await previewFilesToCopy(fx.project, undefined);
  assert.equal(found.source, "default");
  assert.deepEqual(found.matches, [".env", ".env.local", "apps/web/.env"]);
  const custom = await previewFilesToCopy(fx.project, [".env*", "!apps/**"]);
  assert.equal(custom.source, "setting");
  assert.deepEqual(custom.matches, [".env", ".env.local"]);
  await fs.writeFile(path.join(fx.project, ".worktreeinclude"), ".env.local\n");
  const included = await previewFilesToCopy(fx.project, [".env"]);
  assert.equal(included.source, "worktreeinclude");
  assert.equal(included.worktreeInclude, ".env.local\n");
  assert.deepEqual(included.matches, [".env.local"]);
});

// A main branch sync has just fetched the base's upstream, so the Worktree doesn't wait on a second fetch.
test("createWorktree skips its own fetch when the upstream was just fetched", async (t) => {
  const { root, project, git } = await trailingClone(t);
  const stale = git("rev-parse", "origin/main").trim();
  const created = await createWorktree({
    projectPath: project,
    baseBranch: "main",
    prompt: "x",
    root: path.join(root, "worktrees"),
    suffix: "nf1",
    fetched: true,
  });
  assert.equal(git("rev-parse", created.branch).trim(), stale);
  assert.equal(git("rev-parse", "origin/main").trim(), stale);
});

test("createWorktree can start on a named branch, whose folder takes the branch's last segment", async (t) => {
  const { root, project, git } = await fixture(t);
  const worktreeRoot = path.join(root, "worktrees");
  const created = await createWorktree({ projectPath: project, baseBranch: "main", branch: "eng-12-fix-login", root: worktreeRoot, suffix: "ab12" });
  assert.deepEqual(created, {
    branch: "eng-12-fix-login",
    path: path.join(worktreeRoot, "shop", "eng-12-fix-login-ab12"),
    base: "main",
  });
  assert.match(git("worktree", "list", "--porcelain"), /branch refs\/heads\/eng-12-fix-login\n/);
  for (const branch of ["-rf", "bad\nname", "bad..name", "", "x\0y"]) {
    await assert.rejects(createWorktree({ projectPath: project, baseBranch: "main", branch, root: worktreeRoot, suffix: "q1" }), /not a valid branch name/);
  }
});

test("issueBranch uses the issue's branch name, falls back when git refuses it, and suffixes a taken name", async (t) => {
  const { project, git } = await fixture(t);
  const issue = { key: "ENG-12", title: "Fix the login redirect!", branchName: "eng-12-fix-login-redirect" };
  assert.equal(await issueBranch({ projectPath: project, issue, suffix: "ab12" }), "eng-12-fix-login-redirect");
  assert.equal(await issueBranch({ projectPath: project, issue: { ...issue, branchName: "-bad..name" }, suffix: "ab12" }), "eng-12-fix-the-login-redirect");
  assert.equal(await issueBranch({ projectPath: project, issue: { key: "ENG-12", title: "", branchName: "" }, suffix: "ab12" }), "eng-12");
  git("branch", "eng-12-fix-login-redirect");
  assert.equal(await issueBranch({ projectPath: project, issue, suffix: "ab12" }), "eng-12-fix-login-redirect-ab12");
});

test("issueBranch suffixes a name a teammate already pushed to origin", async (t) => {
  const { project, git } = await fixture(t);
  const issue = { key: "ENG-12", title: "Fix the login redirect!", branchName: "eng-12-fix-login-redirect" };
  git("update-ref", "refs/remotes/origin/eng-12-fix-login-redirect", "HEAD");
  assert.equal(await issueBranch({ projectPath: project, issue, suffix: "ab12" }), "eng-12-fix-login-redirect-ab12");
});

test("validBranchName refuses HEAD, and createWorktree refuses it as a branch", async (t) => {
  const { project } = await fixture(t);
  const issue = { key: "ENG-12", title: "Head", branchName: "HEAD" };
  assert.equal(await issueBranch({ projectPath: project, issue, suffix: "ab12" }), "eng-12-head");
  assert.equal(await issueBranch({ projectPath: project, issue: { ...issue, branchName: "refs/heads/x" }, suffix: "ab12" }), "eng-12-head");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-head-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(createWorktree({ projectPath: project, baseBranch: "main", branch: "HEAD", root, suffix: "ab12" }), {
    message: '"HEAD" is not a valid branch name.',
  });
});
