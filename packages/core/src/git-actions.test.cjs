const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CONFLICTS, DETACHED_COMMIT, GH_LOGIN, GH_MISSING, NOT_REPO, NOT_TOP, NO_ORIGIN, createGitActions, looksSecret } = require("./git-actions.cjs");
const { gitMessage } = require("@milagre/shared/git-codes");

// A stand-in for the GitHub CLI: it records each call (arguments, stdin, folder) and answers
// `gh pr view`, `gh pr create` and `gh repo set-default --view` from a state file beside it. Like gh,
// it takes the current branch when none is named. Never the real gh.
const FAKE_GH = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const stateFile = path.join(__dirname, "gh-state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
const args = process.argv.slice(2);
const stdin = args.includes("--body-file") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(path.join(__dirname, "gh-calls.jsonl"), JSON.stringify({ args, stdin, cwd: process.cwd() }) + "\\n");
if (state.loggedOut) {
  process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\\n");
  process.exit(4);
}
const branch = () => execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
const prs = state.prs || {};
if (args[0] === "repo" && args[1] === "set-default") {
  if (state.defaultRepo) process.stdout.write(state.defaultRepo + "\\n");
  else process.stderr.write("no default repository has been set\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const pr = prs[branch()];
  if (!pr) {
    process.stderr.write('no pull requests found for branch "' + branch() + '"\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ url: pr.url, state: pr.state }) + "\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  if (state.createError) {
    process.stderr.write(state.createError + "\\n");
    process.exit(1);
  }
  const number = state.nextNumber || 12;
  const url = "https://github.com/" + (state.defaultRepo || "example/shop") + "/pull/" + number;
  prs[branch()] = { url, state: "OPEN" };
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, prs, nextNumber: number + 1 }));
  process.stderr.write("Creating pull request\\n");
  process.stdout.write(url + "\\n");
  process.exit(0);
}
process.stderr.write("unknown command\\n");
process.exit(1);
`;

// A logged-out gh, first on the tests' PATH: what a CI runner with gh installed looks like. The actions
// are always given the fake's path (or a missing one), so this one must never answer.
const DECOY_GH = `#!${process.execPath}
process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\\n");
process.exit(4);
`;

// Run first in a gh.exe that is node (Windows): it runs the gh script beside it with gh's own arguments. Node took the
// first argument for its script and made it absolute, so it is given back as typed.
const WINDOWS_GH_PRELOAD = `
const path = require("node:path");
if (/^gh\\.exe$/i.test(path.basename(process.execPath))) {
  const script = path.join(path.dirname(process.execPath), "gh");
  const first = process.argv[1] === undefined ? [] : [path.basename(process.argv[1])];
  process.argv = [process.execPath, script, ...first, ...process.argv.slice(2)];
  require("node:module").prototype._compile.call(new (require("node:module"))(script), require("node:fs").readFileSync(script, "utf8").replace(/^#!.*\\n/, ""), script);
  process.exit(process.exitCode ?? 0);
}
`;

// A copy of node, made once per run, that the gh.exe links point at: a link to the node running these tests is the
// running program's file, which Windows won't let a test's cleanup delete.
let nodeCopy;
function windowsNodeCopy() {
  nodeCopy ??= (async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-actions-node-"));
    process.once("exit", () => require("node:fs").rmSync(folder, { recursive: true, force: true }));
    const file = path.join(folder, "node.exe");
    await fs.copyFile(process.execPath, file);
    return file;
  })();
  return nodeCopy;
}

/**
 * A project on main with a local bare repo as origin, and a worktree on its own branch. Git reads no
 * global or system config. The actions run the fake gh by its path (`gh: false` gives them a path where
 * nothing is installed), never a gh found on PATH: PATH starts with a logged-out decoy and keeps the
 * machine's own folders, so a gh installed there is within reach and still not used.
 */
async function fixture(t, { origin = true, gh = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-actions-")));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const bin = path.join(root, "bin");
  const decoy = path.join(root, "decoy");
  await fs.mkdir(bin);
  await fs.mkdir(decoy);
  if (gh) await fs.writeFile(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  await fs.writeFile(path.join(decoy, "gh"), DECOY_GH, { mode: 0o755 });
  // Windows runs a program without a shell only if it is an executable, so there each gh is node itself, linked as
  // gh.exe beside its script, which a preload runs in its place.
  const nodeOptions = {};
  if (process.platform === "win32") {
    const node = await windowsNodeCopy();
    for (const folder of gh ? [bin, decoy] : [decoy])
      await fs.link(node, path.join(folder, "gh.exe")).catch(() => fs.copyFile(node, path.join(folder, "gh.exe")));
    const preload = path.join(root, "gh-preload.cjs");
    await fs.writeFile(preload, WINDOWS_GH_PRELOAD);
    // NODE_OPTIONS reads a backslash as an escape.
    nodeOptions.NODE_OPTIONS = `--require "${preload.replaceAll("\\", "/")}"`;
  }
  const gitconfig = path.join(root, "gitconfig");
  await fs.writeFile(gitconfig, "[user]\n\tname = Milagre\n\temail = milagre@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");
  const env = {
    HOME: root,
    PATH: [decoy, process.env.PATH ?? "", "/usr/bin", "/bin"].join(path.delimiter),
    ...nodeOptions,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_EDITOR: "true",
  };
  const run = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  // A git command that is meant to fail (a conflicting merge, say).
  const fail = (cwd, ...args) => assert.throws(() => run(cwd, ...args));

  const project = path.join(root, "shop");
  await fs.mkdir(project);
  run(project, "init", "-b", "main");
  await fs.writeFile(path.join(project, "README.md"), "shop\n");
  await fs.writeFile(path.join(project, "cart.js"), "export const cart = [];\n");
  run(project, "add", ".");
  run(project, "commit", "-m", "init");
  const bare = path.join(root, "origin.git");
  if (origin) {
    run(root, "init", "--bare", "-b", "main", bare);
    run(project, "remote", "add", "origin", bare);
    run(project, "push", "-u", "origin", "main");
  }
  const worktree = path.join(root, "checkout-page");
  run(project, "worktree", "add", "--no-track", "-b", "milagre/checkout-page", worktree, "main");

  const ghCalls = async () => {
    try {
      return (await fs.readFile(path.join(bin, "gh-calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const setGh = (state) => fs.writeFile(path.join(bin, "gh-state.json"), JSON.stringify(state));
  const ghPath = path.join(bin, "gh");
  return { root, project, worktree, bare, env, run, fail, ghCalls, setGh, actions: createGitActions({ env, gh: ghPath }) };
}

/** A worktree whose branch and main both changed cart.js, so merging, picking or rebasing conflicts. */
async function conflicting(fixtureValue) {
  const { project, worktree, run } = fixtureValue;
  await fs.writeFile(path.join(project, "cart.js"), "export const cart = ['main'];\n");
  run(project, "commit", "-am", "fix: main's cart");
  await fs.writeFile(path.join(worktree, "cart.js"), "export const cart = ['branch'];\n");
  run(worktree, "commit", "-am", "fix: the branch's cart");
  return fixtureValue;
}

test("readChanges lists staged, unstaged and untracked files with their line counts", async (t) => {
  const { worktree, run, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, "cart.js"), "export const cart = [];\nexport const total = 0;\n");
  await fs.writeFile(path.join(worktree, "checkout.js"), "one\ntwo\nthree\n");
  await fs.writeFile(path.join(worktree, "README.md"), "shop\nstaged line\n");
  run(worktree, "add", "README.md");
  // Milagre's own state isn't the chat's work.
  await fs.mkdir(path.join(worktree, ".milagre"));
  await fs.writeFile(path.join(worktree, ".milagre", "coordination.json"), "{}\n");

  const changes = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.equal(changes.isRepo, true);
  assert.equal(changes.branch, "milagre/checkout-page");
  assert.equal(changes.base, "main");
  assert.equal(changes.hasChanges, true);
  assert.deepEqual(changes.files, [
    { path: "README.md", status: "modified", added: 1, removed: 0 },
    { path: "cart.js", status: "modified", added: 1, removed: 0 },
    { path: "checkout.js", status: "added", added: 3, removed: 0 },
  ]);
  assert.equal(changes.hasOrigin, true);
  assert.equal(changes.remotes, 1);
  assert.equal(changes.prRepo, null);
  assert.equal(changes.onBase, false);
  assert.equal(changes.unpushed, 0);
  assert.equal(changes.commitBlocked, null);
});

test("readChanges refuses a folder that isn't a repository or isn't the top of its checkout", async (t) => {
  const { root, worktree, actions } = await fixture(t);
  const plain = path.join(root, "plain");
  await fs.mkdir(plain);
  assert.deepEqual(await actions.readChanges({ cwd: plain }), { isRepo: false, message: NOT_REPO });
  const inside = path.join(worktree, "src");
  await fs.mkdir(inside);
  await fs.writeFile(path.join(inside, "a.js"), "a\n");
  assert.deepEqual(await actions.readChanges({ cwd: inside }), { isRepo: false, message: NOT_TOP });
  // Nothing is committed into the enclosing checkout.
  assert.deepEqual(await actions.commit({ cwd: inside, message: "feat: a" }), { ok: false, kind: "error", message: NOT_TOP });
  assert.deepEqual(await actions.push({ cwd: inside }), { ok: false, kind: "error", message: NOT_TOP });
  assert.deepEqual(await actions.openPr({ cwd: inside, title: "a", body: "" }), { ok: false, kind: "error", message: NOT_TOP });
});

test("commit stages everything and takes the message from stdin", async (t) => {
  const { worktree, run, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, "checkout.js"), "export function checkout() {}\n");
  await fs.writeFile(path.join(worktree, "cart.js"), "export const cart = [1];\n");
  await fs.mkdir(path.join(worktree, ".milagre"));
  await fs.writeFile(path.join(worktree, ".milagre", "coordination.json"), "{}\n");
  const message = 'feat: add the checkout page\n\nIt reads the cart\'s "total" and $HOME stays literal.';

  const result = await actions.commit({ cwd: worktree, message });
  assert.equal(result.ok, true);
  assert.equal(result.sha, run(worktree, "rev-parse", "HEAD"));
  assert.equal(result.shortSha, run(worktree, "rev-parse", "--short", "HEAD"));
  assert.equal(run(worktree, "log", "-1", "--format=%B"), message);
  assert.deepEqual(run(worktree, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["cart.js", "checkout.js"]);
  // Only Milagre's state is left over.
  assert.equal(run(worktree, "status", "--porcelain", "--untracked-files=all"), "?? .milagre/coordination.json");
});

test("commit leaves out a .milagre path that was staged before", async (t) => {
  const { worktree, run, actions } = await fixture(t);
  await fs.mkdir(path.join(worktree, ".milagre"));
  await fs.writeFile(path.join(worktree, ".milagre", "coordination.json"), "{}\n");
  run(worktree, "add", ".milagre/coordination.json");
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");
  assert.equal((await actions.commit({ cwd: worktree, message: "feat: checkout" })).ok, true);
  assert.deepEqual(run(worktree, "show", "--name-only", "--format=", "HEAD").split("\n"), ["checkout.js"]);
  assert.equal(run(worktree, "status", "--porcelain", "--untracked-files=all"), "?? .milagre/coordination.json");
});

test("commit refuses an empty message and an empty change", async (t) => {
  const { worktree, actions } = await fixture(t);
  assert.equal((await actions.commit({ cwd: worktree, message: "  \n" })).ok, false);
  const nothing = await actions.commit({ cwd: worktree, message: "fix: nothing" });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.kind, "nothing");
});

test("commit surfaces a failing hook with its output, and makes no commit", async (t) => {
  const { worktree, run, actions } = await fixture(t);
  const hooks = run(worktree, "rev-parse", "--git-path", "hooks");
  await fs.mkdir(path.resolve(worktree, hooks), { recursive: true });
  await fs.writeFile(path.resolve(worktree, hooks, "pre-commit"), "#!/bin/sh\necho 'lint: missing semicolon in checkout.js' >&2\nexit 1\n", { mode: 0o755 });
  await fs.writeFile(path.join(worktree, "checkout.js"), "export function checkout() {}\n");
  const head = run(worktree, "rev-parse", "HEAD");

  const result = await actions.commit({ cwd: worktree, message: "feat: checkout" });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "hook");
  assert.match(result.output, /lint: missing semicolon in checkout\.js/);
  assert.equal(run(worktree, "rev-parse", "HEAD"), head);
});

test("a signing failure is reported as git says it, not as a hook failure", async (t) => {
  const { worktree, run, actions } = await fixture(t);
  const hooks = run(worktree, "rev-parse", "--git-path", "hooks");
  await fs.mkdir(path.resolve(worktree, hooks), { recursive: true });
  await fs.writeFile(path.resolve(worktree, hooks, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  run(worktree, "config", "commit.gpgsign", "true");
  run(worktree, "config", "gpg.program", "/usr/bin/false");
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");

  const result = await actions.commit({ cwd: worktree, message: "feat: checkout" });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "signing");
  assert.match(result.message, /gpg failed/);
  assert.equal(result.output, undefined);
});

test('hook output that says "assigning" is still a hook failure, not a signing one', async (t) => {
  const { worktree, run, actions } = await fixture(t);
  const hooks = run(worktree, "rev-parse", "--git-path", "hooks");
  await fs.mkdir(path.resolve(worktree, hooks), { recursive: true });
  await fs.writeFile(
    path.resolve(worktree, hooks, "pre-commit"),
    "#!/bin/sh\necho 'checkout.js:3 error: assigning to a constant (no-const-assign)' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");

  const result = await actions.commit({ cwd: worktree, message: "feat: checkout" });
  assert.equal(result.kind, "hook");
  assert.match(result.output, /assigning to a constant/);
});

for (const [operation, start] of [
  ["merge", ({ worktree, fail }) => fail(worktree, "merge", "main")],
  ["cherry-pick", ({ worktree, fail }) => fail(worktree, "cherry-pick", "main")],
  ["rebase", ({ worktree, fail }) => fail(worktree, "rebase", "main")],
  ["rebase (apply)", ({ worktree, fail }) => fail(worktree, "rebase", "--apply", "main")],
]) {
  test(`nothing is committed while a ${operation} is in progress`, async (t) => {
    const setup = await conflicting(await fixture(t));
    const { worktree, run, actions } = setup;
    start(setup);
    const head = run(worktree, "rev-parse", "HEAD");
    const reason = `A ${operation.replace(" (apply)", "")} is in progress. Finish or abort it, then commit.`;
    assert.equal((await actions.readChanges({ cwd: worktree, base: "main" })).commitBlocked, reason);
    assert.deepEqual(await actions.commit({ cwd: worktree, message: "fix: merge" }), { ok: false, kind: "blocked", message: reason });
    assert.equal(run(worktree, "rev-parse", "HEAD"), head);
    // The conflict is still a conflict: nothing marked it resolved.
    assert.notEqual(run(worktree, "ls-files", "-u"), "");
  });
}

test("nothing is committed while a revert is in progress", async (t) => {
  const { worktree, run, fail, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, "cart.js"), "export const cart = [1];\n");
  run(worktree, "commit", "-am", "feat: one");
  await fs.writeFile(path.join(worktree, "cart.js"), "export const cart = [2];\n");
  run(worktree, "commit", "-am", "feat: two");
  fail(worktree, "revert", "HEAD~1");
  const reason = "A revert is in progress. Finish or abort it, then commit.";
  assert.equal((await actions.readChanges({ cwd: worktree, base: "main" })).commitBlocked, reason);
  assert.deepEqual(await actions.commit({ cwd: worktree, message: "revert" }), { ok: false, kind: "blocked", message: reason });
});

test("unresolved conflicts without an operation (a stash that didn't apply) block the commit", async (t) => {
  const { worktree, run, fail, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, "cart.js"), "export const cart = ['stashed'];\n");
  run(worktree, "stash");
  await fs.writeFile(path.join(worktree, "cart.js"), "export const cart = ['committed'];\n");
  run(worktree, "commit", "-am", "fix: cart");
  fail(worktree, "stash", "pop");
  assert.equal((await actions.readChanges({ cwd: worktree, base: "main" })).commitBlocked, CONFLICTS);
  assert.deepEqual(await actions.commit({ cwd: worktree, message: "fix" }), { ok: false, kind: "blocked", message: CONFLICTS });
});

test("nothing is committed on a detached HEAD", async (t) => {
  const { worktree, run, actions } = await fixture(t);
  run(worktree, "checkout", "--detach");
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");
  const changes = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.equal(changes.branch, null);
  assert.deepEqual(await actions.commit({ cwd: worktree, message: "feat: checkout" }), {
    ok: false,
    kind: "blocked",
    message: DETACHED_COMMIT,
    code: "DETACHED_COMMIT",
  });
  assert.equal(run(worktree, "status", "--porcelain"), "?? checkout.js");
});

test("looksSecret matches env files, keys and credentials, but not example env files", () => {
  for (const file of [
    ".env",
    ".env.local",
    "config/.env.production",
    "deploy.pem",
    "server.key",
    "AuthKey_ABC.p8",
    "id_rsa",
    "id_ed25519.pub",
    "aws-credentials.json",
    "client_secret.json",
    "Secrets.yml",
  ])
    assert.equal(looksSecret(file), true, file);
  for (const file of ["cart.js", ".env.example", "keyboard.ts", "README.md", "package-lock.json"]) assert.equal(looksSecret(file), false, file);
});

test("readChanges flags secret-looking files", async (t) => {
  const { worktree, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, ".env.local"), "API_KEY=sk-live-123\n");
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");
  const { files } = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.deepEqual(files, [
    { path: ".env.local", status: "added", added: 1, removed: 0, secret: true },
    { path: "checkout.js", status: "added", added: 1, removed: 0 },
  ]);
});

test("commit refuses secret-looking files and puts the index back as it was", async (t) => {
  const { worktree, run, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, "README.md"), "shop\nstaged by hand\n");
  run(worktree, "add", "README.md");
  await fs.writeFile(path.join(worktree, ".env.local"), "API_KEY=sk-live-123\n");
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");
  const head = run(worktree, "rev-parse", "HEAD");

  const result = await actions.commit({ cwd: worktree, message: "feat: checkout" });
  assert.deepEqual(result, {
    ok: false,
    kind: "secrets",
    message: "These look like secrets and would be committed: .env.local. Add them to .gitignore, or commit them yourself if you mean to.",
  });
  assert.equal(run(worktree, "rev-parse", "HEAD"), head);
  // What the user staged stays staged; what Milagre staged doesn't.
  assert.equal(run(worktree, "diff", "--cached", "--name-only"), "README.md");
  assert.deepEqual(run(worktree, "status", "--porcelain", "--untracked-files=all").split("\n"), ["M  README.md", "?? .env.local", "?? checkout.js"]);

  // Once it's ignored, the rest commits.
  await fs.writeFile(path.join(worktree, ".gitignore"), ".env.local\n");
  assert.equal((await actions.commit({ cwd: worktree, message: "feat: checkout" })).ok, true);
  assert.deepEqual(run(worktree, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [".gitignore", "README.md", "checkout.js"]);
});

test("a file renamed to a secret-looking name is refused too", async (t) => {
  const { worktree, run, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, "settings.txt"), "API_KEY=sk-live-123\n");
  run(worktree, "add", "settings.txt");
  run(worktree, "commit", "-m", "chore: settings");
  run(worktree, "mv", "settings.txt", ".env");
  const head = run(worktree, "rev-parse", "HEAD");

  const result = await actions.commit({ cwd: worktree, message: "chore: move settings" });
  assert.deepEqual(result, {
    ok: false,
    kind: "secrets",
    message: "These look like secrets and would be committed: .env. Add them to .gitignore, or commit them yourself if you mean to.",
  });
  assert.equal(run(worktree, "rev-parse", "HEAD"), head);
});

test("push publishes the branch and sets its upstream", async (t) => {
  const { worktree, bare, run, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, "checkout.js"), "export function checkout() {}\n");
  const { sha } = await actions.commit({ cwd: worktree, message: "feat: checkout" });

  const result = await actions.push({ cwd: worktree });
  assert.deepEqual(result, { ok: true, branch: "milagre/checkout-page", remote: "origin" });
  assert.equal(run(bare, "rev-parse", "refs/heads/milagre/checkout-page"), sha);
  assert.equal(run(worktree, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/milagre/checkout-page");
});

async function divergeRemote({ root, bare, run }, branch) {
  const other = path.join(root, `other-${branch.replace(/\W/g, "")}`);
  run(root, "clone", "--branch", branch, bare, other);
  await fs.writeFile(path.join(other, "checkout.js"), "theirs\n");
  run(other, "commit", "-am", "feat: their change");
  run(other, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`);
  return run(bare, "rev-parse", `refs/heads/${branch}`);
}

test("push reports a rejected push without forcing it", async (t) => {
  const setup = await fixture(t);
  const { worktree, bare, run, actions } = setup;
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");
  await actions.commit({ cwd: worktree, message: "feat: checkout v1" });
  assert.equal((await actions.push({ cwd: worktree })).ok, true);
  const theirs = await divergeRemote(setup, "milagre/checkout-page");
  await fs.writeFile(path.join(worktree, "checkout.js"), "mine\n");
  await actions.commit({ cwd: worktree, message: "feat: my change" });

  const result = await actions.push({ cwd: worktree });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "rejected");
  assert.match(result.message, /rejected/);
  assert.match(result.hint, /pull|rebase/i);
  assert.equal(run(bare, "rev-parse", "refs/heads/milagre/checkout-page"), theirs);
});

test("a branch named +x is pushed, never force-pushed", async (t) => {
  const setup = await fixture(t);
  const { worktree, bare, run, actions } = setup;
  run(worktree, "checkout", "-b", "+x");
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");
  await actions.commit({ cwd: worktree, message: "feat: checkout v1" });
  assert.deepEqual(await actions.push({ cwd: worktree }), { ok: true, branch: "+x", remote: "origin" });
  assert.equal(run(worktree, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/+x");
  const theirs = await divergeRemote(setup, "+x");
  await fs.writeFile(path.join(worktree, "checkout.js"), "mine\n");
  await actions.commit({ cwd: worktree, message: "feat: my change" });
  assert.equal((await actions.push({ cwd: worktree })).kind, "rejected");
  assert.equal(run(bare, "rev-parse", "refs/heads/+x"), theirs);
});

test("a repo without origin can commit but not push or open a PR", async (t) => {
  const { worktree, actions, ghCalls } = await fixture(t, { origin: false });
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");
  const changes = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.equal(changes.hasOrigin, false);
  assert.equal(changes.base, "main");
  assert.equal((await actions.commit({ cwd: worktree, message: "feat: checkout" })).ok, true);
  assert.deepEqual(await actions.push({ cwd: worktree }), { ok: false, kind: "no-origin", message: NO_ORIGIN, code: "NO_ORIGIN" });
  assert.deepEqual(await actions.openPr({ cwd: worktree, base: "main", title: "Checkout", body: "" }), {
    ok: false,
    kind: "no-origin",
    message: NO_ORIGIN,
    code: "NO_ORIGIN",
  });
  assert.deepEqual(await ghCalls(), []);
});

test("without gh, opening a PR says how to install it", async (t) => {
  const { worktree, actions } = await fixture(t, { gh: false });
  const changes = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.equal(changes.ghReady, false);
  assert.equal(changes.ghMessage, GH_MISSING);
  assert.deepEqual(await actions.openPr({ cwd: worktree, base: "main", title: "Checkout", body: "" }), {
    ok: false,
    kind: "gh-missing",
    message: GH_MISSING,
    code: "GH_MISSING",
  });
});

test("the gh install hint names the host's platform", () => {
  assert.match(gitMessage("GH_MISSING", "darwin"), /brew install gh/);
  assert.match(gitMessage("GH_MISSING", "win32"), /winget install --id GitHub\.cli/);
  assert.match(gitMessage("GH_MISSING", "linux"), /cli\.github\.com/);
  assert.equal(GH_MISSING, gitMessage("GH_MISSING", process.platform));
  assert.equal(gitMessage("NO_ORIGIN", "win32"), NO_ORIGIN);
});

test("when gh is signed out, opening a PR says to log in", async (t) => {
  const { worktree, actions, setGh, ghCalls } = await fixture(t);
  await setGh({ loggedOut: true });
  const changes = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.equal(changes.ghReady, false);
  assert.equal(changes.ghMessage, GH_LOGIN);
  assert.deepEqual(await actions.openPr({ cwd: worktree, base: "main", title: "Checkout", body: "" }), { ok: false, kind: "gh-auth", message: GH_LOGIN });
  // The fake answered both, not the logged-out gh on PATH.
  assert.deepEqual(
    (await ghCalls()).map((call) => call.args.slice(0, 2)),
    [
      ["pr", "view"],
      ["pr", "create"],
    ],
  );
});

test("openPr passes the base and title as --flag=value, the body on stdin, and lets gh find the head", async (t) => {
  const { worktree, actions, ghCalls } = await fixture(t);
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");
  await actions.commit({ cwd: worktree, message: "feat: checkout" });
  await actions.push({ cwd: worktree });
  const body = "Adds the checkout page.\n\n- Reads the cart total";

  // A base recorded as the remote-tracking ref still names the remote's branch; a title starting
  // with a dash stays a title.
  const result = await actions.openPr({ cwd: worktree, base: "origin/main", title: "--feat: add the checkout page", body });
  assert.deepEqual(result, { ok: true, url: "https://github.com/example/shop/pull/12", number: 12 });
  assert.deepEqual((await ghCalls()).at(-1), {
    args: ["pr", "create", "--base=main", "--title=--feat: add the checkout page", "--body-file", "-"],
    stdin: body,
    cwd: worktree,
  });
});

test("openPr shows gh's own message for any other failure", async (t) => {
  const { worktree, actions, setGh } = await fixture(t);
  await setGh({ createError: "pull request create failed: GraphQL: No commits between main and milagre/checkout-page" });
  const result = await actions.openPr({ cwd: worktree, base: "main", title: "Checkout", body: "" });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "error");
  assert.match(result.message, /No commits between main and milagre\/checkout-page/);
});

test("readChanges finds the current branch's open PR without naming the branch", async (t) => {
  const { worktree, actions, setGh, ghCalls } = await fixture(t);
  await setGh({ prs: { "milagre/checkout-page": { url: "https://github.com/example/shop/pull/7", state: "OPEN" } } });
  const changes = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.equal(changes.ghReady, true);
  assert.deepEqual(changes.pr, { number: 7, url: "https://github.com/example/shop/pull/7", state: "OPEN" });
  assert.deepEqual((await ghCalls()).at(-1), { args: ["pr", "view", "--json", "url,state"], stdin: "", cwd: worktree });

  // A merged or closed PR isn't open: a new one can be opened.
  await setGh({ prs: { "milagre/checkout-page": { url: "https://github.com/example/shop/pull/7", state: "MERGED" } } });
  assert.equal((await actions.readChanges({ cwd: worktree, base: "main" })).pr, null);
  await setGh({});
  const none = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.equal(none.ghReady, true);
  assert.equal(none.pr, null);
});

test("in a fork with an upstream remote, the PR goes where gh's default repo says", async (t) => {
  const { root, worktree, run, actions, setGh, ghCalls } = await fixture(t);
  const upstream = path.join(root, "upstream.git");
  run(root, "init", "--bare", "-b", "main", upstream);
  run(worktree, "remote", "add", "upstream", upstream);
  await setGh({ defaultRepo: "acme/shop" });
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");

  const changes = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.equal(changes.remotes, 2);
  assert.equal(changes.prRepo, "acme/shop");
  await actions.commit({ cwd: worktree, message: "feat: checkout" });
  await actions.push({ cwd: worktree });
  const result = await actions.openPr({ cwd: worktree, base: "main", title: "feat: checkout", body: "" });
  assert.deepEqual(result, { ok: true, url: "https://github.com/acme/shop/pull/12", number: 12 });
  assert.equal(
    (await ghCalls()).at(-1).args.some((arg) => arg.startsWith("--head")),
    false,
  );

  // No default repo set: the dialog says how to choose one.
  await setGh({});
  assert.equal((await actions.readChanges({ cwd: worktree, base: "main" })).prRepo, null);
});

test("readChanges counts commits waiting to be pushed when nothing is left to commit", async (t) => {
  const { worktree, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");
  await actions.commit({ cwd: worktree, message: "feat: checkout" });
  let changes = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.equal(changes.hasChanges, false);
  assert.deepEqual(changes.files, []);
  assert.equal(changes.unpushed, 1);
  assert.equal(changes.ahead, 1);

  await actions.push({ cwd: worktree });
  await fs.writeFile(path.join(worktree, "checkout.js"), "v2\n");
  await actions.commit({ cwd: worktree, message: "feat: checkout v2" });
  changes = await actions.readChanges({ cwd: worktree, base: "main" });
  assert.equal(changes.unpushed, 1);
  assert.equal(changes.ahead, 2);
});

test("the main checkout on its base branch can't open a PR", async (t) => {
  const { project, actions, ghCalls } = await fixture(t);
  await fs.writeFile(path.join(project, "cart.js"), "export const cart = [2];\n");
  const changes = await actions.readChanges({ cwd: project });
  assert.equal(changes.branch, "main");
  assert.equal(changes.base, "main");
  assert.equal(changes.onBase, true);
  assert.equal(changes.hasChanges, true);
  // No PR can come of it, so gh isn't asked.
  assert.deepEqual(await ghCalls(), []);
  const result = await actions.openPr({ cwd: project, title: "Cart", body: "" });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "on-base");
});

test("readTextContext gives a stat, the diff with untracked files, and the repo's recent subjects", async (t) => {
  const { worktree, run, actions } = await fixture(t);
  for (let index = 1; index <= 16; index++) run(worktree, "commit", "--allow-empty", "-m", `chore: step ${index}`);
  await fs.writeFile(path.join(worktree, "cart.js"), "export const cart = [3];\n");
  await fs.writeFile(path.join(worktree, "checkout.js"), "export function checkout() {}\n");

  const context = await actions.readTextContext({ cwd: worktree, base: "main" });
  assert.match(context.diff, /-export const cart = \[\];\n\+export const cart = \[3\];/);
  assert.match(context.diff, /\+export function checkout\(\) \{\}/);
  assert.match(context.stat, /cart\.js \| 2 \+-/);
  assert.match(context.stat, /checkout\.js \(new file, 1 lines\)/);
  assert.deepEqual(context.omitted, []);
  assert.equal(context.recentSubjects.length, 15);
  assert.equal(context.recentSubjects[0], "chore: step 16");
  assert.equal(context.branchCommits.length, 16);
  assert.equal(context.branch, "milagre/checkout-page");
  assert.equal(context.base, "main");

  // With nothing left to commit, the PR is described by the branch's own changes.
  await actions.commit({ cwd: worktree, message: "feat: checkout" });
  const committed = await actions.readTextContext({ cwd: worktree, base: "main" });
  assert.match(committed.diff, /\+export function checkout\(\) \{\}/);
  assert.match(committed.stat, /checkout\.js/);
  assert.equal(committed.hasChanges, false);
});

test("readTextContext names secret-looking files and lockfiles but never shows their contents", async (t) => {
  const { worktree, run, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, "package-lock.json"), '{"lockfileVersion": 3}\n');
  await fs.writeFile(path.join(worktree, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n");
  run(worktree, "add", "package-lock.json", "deploy.pem");
  run(worktree, "commit", "-m", "chore: lock");
  await fs.writeFile(path.join(worktree, "package-lock.json"), '{"lockfileVersion": 3, "LOCK-CONTENT": true}\n');
  await fs.writeFile(path.join(worktree, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\nTRACKED-KEY-CONTENT\n");
  await fs.writeFile(path.join(worktree, ".env.local"), "API_KEY=UNTRACKED-SECRET-CONTENT\n");
  await fs.writeFile(path.join(worktree, "checkout.js"), "v1\n");

  const context = await actions.readTextContext({ cwd: worktree, base: "main" });
  for (const hidden of ["LOCK-CONTENT", "TRACKED-KEY-CONTENT", "UNTRACKED-SECRET-CONTENT"]) assert.ok(!context.diff.includes(hidden), hidden);
  assert.match(context.diff, /\+v1/);
  assert.deepEqual(context.omitted, [
    { path: ".env.local", reason: "secret" },
    { path: "deploy.pem", reason: "secret" },
    { path: "package-lock.json", reason: "lockfile" },
  ]);
});

test("one big untracked file can't crowd the others out of the diff", async (t) => {
  const { worktree, actions } = await fixture(t);
  // Sorted first, so it's read first.
  await fs.writeFile(path.join(worktree, "a-big.txt"), `${"x".repeat(99)}\n`.repeat(2000));
  await fs.writeFile(path.join(worktree, "b-small.js"), "export const small = 'SMALL-FILE-CONTENT';\n");
  await fs.writeFile(path.join(worktree, "c-small.js"), "export const other = 'OTHER-FILE-CONTENT';\n");
  const context = await actions.readTextContext({ cwd: worktree, base: "main" });
  assert.match(context.diff, /\[a-big\.txt is cut off here\.\]/);
  assert.match(context.diff, /SMALL-FILE-CONTENT/);
  assert.match(context.diff, /OTHER-FILE-CONTENT/);
  // The big file got a quarter of the budget, not all of it.
  const big = context.diff.slice(0, context.diff.indexOf("[a-big.txt is cut off here.]"));
  assert.ok(big.length < 10_500, String(big.length));
});

test("readTextContext reads no more of a large untracked file than the diff can hold", async (t) => {
  const { worktree, actions } = await fixture(t);
  await fs.writeFile(path.join(worktree, "big.txt"), `${"x".repeat(99)}\n`.repeat(2000));
  await fs.writeFile(path.join(worktree, "small.txt"), "small\n");
  const context = await actions.readTextContext({ cwd: worktree, base: "main" });
  assert.ok(context.diff.length < 41_000, String(context.diff.length));
  assert.match(context.diff, /\[big\.txt is cut off here\.\]/);
});
