const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createGit, LIMITS } = require("./git/client.cjs");
const { configuredHelper } = require("./git/test-helpers.cjs");

const WORKTREES = ["/home/me/my shop", "/home/me/worktrees/cart"];
const nulListing = "worktree /home/me/my shop\0HEAD abc\0branch refs/heads/main\0\0worktree /home/me/worktrees/cart\0HEAD def\0detached\0\0";
const lineListing =
  "worktree /home/me/my shop\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/me/worktrees/cart\nHEAD def\ndetached\nprunable gitdir file points to non-existent location\n\n";

test("analysis Git ignores inherited command/config environment overrides", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-analysis-git-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const { helper, marker } = await configuredHelper(root, "fsmonitor", "notes.txt");
  execFileSync("git", ["-C", root, "config", "--unset", "core.fsmonitor"]);
  const git = createGit({
    analysisOnly: true,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: helper,
      GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${helper}'`,
      GIT_EXTERNAL_DIFF: helper,
      GIT_PAGER: helper,
    },
  });
  await git.read.text(root, ["status", "--short"]);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});

function oldGit(calls, stderr = "error: unknown switch `z'\nusage: git worktree list [-v | --porcelain [-z]]\n") {
  return createGit({
    execFile(_command, args, _options, done) {
      calls.push(args);
      if (args.includes("-z")) {
        const error = Object.assign(new Error("exit 129"), { code: 129 });
        done(error, "", stderr);
      } else done(null, lineListing, "");
    },
  });
}

test("worktree list falls back to newline records on Git before 2.36 and matches the -z result", async () => {
  const modern = createGit({ execFile: (_command, _args, _options, done) => done(null, nulListing, "") });
  const expected = await modern.worktreeList("/home/me/my shop");
  assert.deepEqual(
    expected.map((entry) => entry.path),
    WORKTREES,
  );
  const calls = [];
  const git = oldGit(calls);
  assert.deepEqual(await git.worktreeList("/home/me/my shop"), expected);
  assert.deepEqual(await git.worktreeList("/home/me/my shop"), expected);
  // The failing -z form is tried once per process, then remembered.
  assert.equal(calls.filter((args) => args.includes("-z")).length, 1);
  assert.equal(calls.length, 3);
});

test("worktree list falls back on Git's usage-error exit code when its message is localized", async () => {
  const calls = [];
  const git = oldGit(calls, "erro: chave desconhecida `z'\nuso: git worktree list [-v | --porcelain [-z]]\n");
  assert.deepEqual(
    (await git.worktreeList("/home/me/my shop")).map((entry) => entry.path),
    WORKTREES,
  );
  assert.equal(calls.length, 2);
});

test("worktree list still reports unrelated Git failures", async () => {
  const git = createGit({
    execFile: (_command, _args, _options, done) => done(Object.assign(new Error("x"), { code: 128 }), "", "fatal: not a git repository"),
  });
  await assert.rejects(git.worktreeList("/nowhere"), /not a git repository/);
});

test("Windows Git worktree paths use native separators at the client boundary", async () => {
  const git = createGit({
    platform: "win32",
    execFile(_command, _args, _options, done) {
      done(null, "worktree C:/Users/me/shop\0branch refs/heads/main\0\0worktree C:/Users/me/worktrees/cart\0detached\0\0", "");
    },
  });
  assert.deepEqual(await git.worktreeList("C:\\Users\\me\\shop"), [
    { path: "C:\\Users\\me\\shop", name: "main" },
    { path: "C:\\Users\\me\\worktrees\\cart", name: "cart" },
  ]);
});

test("Windows Git worktrees use filesystem identities rather than Git path spelling", async () => {
  const canonical = "C:\\Users\\Me\\Shop";
  const git = createGit({
    platform: "win32",
    realpath: async (folder) => {
      assert.equal(folder, "c:/users/me/shop");
      return canonical;
    },
    execFile(_command, _args, _options, done) {
      done(null, "worktree c:/users/me/shop\0branch refs/heads/main\0\0", "");
    },
  });
  assert.deepEqual(await git.worktreeList(canonical), [{ path: canonical, name: "main" }]);
});

test("every Git profile has bounded output, a deadline and a noninteractive environment", async () => {
  const calls = [];
  const git = createGit({
    env: { PATH: "/bin", GIT_TERMINAL_PROMPT: "1" },
    execFile(command, args, options, done) {
      calls.push({ command, args, options });
      done(null, "ok\n", "");
      return { stdin: { on() {}, end() {} } };
    },
  });
  await git.run("/repo", ["status", "--porcelain"]);
  await git.write.run("/repo", ["fetch"], { profile: "NETWORK" });
  await git.write.run("/repo", ["worktree", "remove", "/repo/wt"], { profile: "REMOVE" });
  assert.deepEqual(
    calls.map((c) => c.options.timeout),
    [10000, 30000, 300000],
  );
  for (const c of calls) {
    assert.equal(c.command, "git");
    assert.equal(c.options.cwd, "/repo");
    assert.deepEqual(c.args.slice(0, 2), ["-C", "/repo"]);
    assert.equal(c.options.env.GIT_TERMINAL_PROMPT, "0");
    assert.match(c.options.env.GIT_SSH_COMMAND, /BatchMode=yes/);
    assert.equal(c.options.maxBuffer, 16 * 1024 * 1024);
  }
  assert.equal(LIMITS.COMMIT.timeout, 300000);
  assert.equal(LIMITS.PUSH.timeout, 300000);
});

test("stdin reaches Git and failed commands retain their output and exit status", async () => {
  let input;
  const git = createGit({
    execFile(command, args, options, done) {
      return {
        stdin: {
          on() {},
          end(value) {
            input = value;
            done(Object.assign(new Error("failed"), { code: 1 }), "partial", "hook refused");
          },
        },
      };
    },
  });
  const result = await git.write.run("/repo", ["commit", "-F", "-"], { profile: "COMMIT", input: "literal $() `text`\n" });
  assert.equal(input, "literal $() `text`\n");
  assert.deepEqual(result, {
    ok: false,
    code: 1,
    missing: false,
    timedOut: false,
    overflow: false,
    stdout: "partial",
    stderr: "hook refused",
    message: "hook refused",
  });
});

test("spawn errors, timeouts and buffer overflow share the same failure fields", async () => {
  for (const [error, flag] of [
    [{ code: "ENOENT" }, "missing"],
    [{ killed: true }, "timedOut"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "overflow"],
  ]) {
    const git = createGit({
      execFile(command, args, options, done) {
        done(Object.assign(new Error("failure"), error), "", "");
      },
    });
    const result = await git.run("/repo", ["status"]);
    assert.equal(result.ok, false);
    assert.equal(result.code, null);
    assert.equal(result[flag], true);
    assert.equal(result.message, "failure");
    await assert.rejects(git.checked("/repo", ["status"]), (e) => e.message === "failure" && e[flag] === true && e.code === null);
  }
  const git = createGit({
    execFile() {
      throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    },
  });
  assert.equal((await git.run("/repo", ["status"])).missing, true);
});

test("the read surface rejects mutations before starting a process", async () => {
  let calls = 0;
  const git = createGit({
    execFile() {
      calls++;
    },
  });
  for (const args of [["commit"], ["push"], ["worktree", "remove", "/repo"], ["symbolic-ref", "HEAD", "refs/heads/other"], ["diff", "--output=/tmp/out"]]) {
    await assert.rejects(git.read.run("/repo", args), /read/i);
  }
  assert.equal(calls, 0);
  assert.equal(git.read.write, undefined);
});

test("ref lookup terminates options and resolveBase never submits a leading-dash recorded base", async () => {
  const calls = [];
  const git = createGit({
    execFile(command, args, options, done) {
      calls.push(args);
      done(Object.assign(new Error("missing"), { code: 1 }), "", "");
    },
  });
  assert.equal(await git.refExists("/repo", "--all"), false);
  assert.deepEqual(calls[0], ["-C", "/repo", "rev-parse", "--verify", "--quiet", "--end-of-options", "--all^{commit}"]);
  calls.length = 0;
  assert.deepEqual(await git.resolveBase("/repo", "--all"), { name: "main", ref: null });
  assert.equal(
    calls.some((args) => args.some((arg) => arg.includes("--all"))),
    false,
  );
});

test("real Git resolves recorded/default bases, common directories and newline Worktree paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-git-client-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  const run = (...args) =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  run("init", "-b", "main");
  run("commit", "--allow-empty", "-m", "initial");
  const wt = path.join(root, "work\ntree");
  run("worktree", "add", "-b", "feature", wt);
  const git = createGit();
  assert.deepEqual(await git.resolveBase(repo, "feature"), { name: "feature", ref: "feature" });
  assert.deepEqual(await git.resolveBase(repo, "missing"), { name: "main", ref: "refs/heads/main" });
  assert.equal(await git.commonDir(wt), await fs.realpath(path.join(repo, ".git")));
  const worktrees = await git.worktreeList(repo);
  assert.deepEqual(
    worktrees.map((w) => ({ path: w.path, name: w.name })),
    [
      { path: await fs.realpath(repo), name: "main" },
      { path: await fs.realpath(wt), name: "feature" },
    ],
  );
  run("update-ref", "refs/remotes/origin/trunk", "HEAD");
  run("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  assert.deepEqual(await git.resolveBase(repo), { name: "trunk", ref: "refs/remotes/origin/trunk" });

  // A recorded local base is used while it is level with or ahead of its remote, and the remote once it
  // falls behind or diverges (a force-pushed main left the local branch on the old history).
  run("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.deepEqual(await git.resolveBase(repo, "main"), { name: "main", ref: "main" });
  run("commit", "--allow-empty", "-m", "local only");
  assert.deepEqual(await git.resolveBase(repo, "main"), { name: "main", ref: "main" });
  run("update-ref", "refs/remotes/origin/main", run("commit-tree", "-m", "rewritten", "HEAD^{tree}"));
  assert.deepEqual(await git.resolveBase(repo, "main"), { name: "main", ref: "refs/remotes/origin/main" });

  // With no recorded base, a chat's branch is measured against the branch it was cut from.
  run("branch", "stack", "main");
  const stacked = path.join(root, "stacked");
  run("worktree", "add", "-b", "on-stack", stacked, "stack");
  assert.deepEqual(await git.chatBase(stacked), { name: "stack", ref: "stack" });
  assert.deepEqual(await git.chatBase(stacked, "main"), { name: "main", ref: "refs/remotes/origin/main" }, "a recorded base wins");
  const fromHead = path.join(root, "from-head");
  run("worktree", "add", "-b", "from-head", fromHead);
  assert.deepEqual(await git.chatBase(fromHead), { name: "trunk", ref: "refs/remotes/origin/trunk" }, "made from HEAD: the default");
});

test("Git process execution belongs only to the Git client", async () => {
  const roots = [__dirname, path.resolve(__dirname, "../../../apps/desktop/electron")];
  const violations = [];
  for (const root of roots) {
    for (const name of await fs.readdir(root, { recursive: true })) {
      if (!name.endsWith(".cjs") || name.endsWith(".test.cjs") || name.startsWith("git/")) continue;
      const source = await fs.readFile(path.join(root, name), "utf8");
      if (/\b(?:execFile|execFileAsync|spawn|run|exec)\s*\(\s*['"]git['"]/.test(source)) violations.push(name);
    }
  }
  assert.deepEqual(violations, []);
});

test("the read surface runs git grep but never its pager option, attached or not", async () => {
  const { createGit } = require("./git/client.cjs");
  const calls = [];
  const git = createGit({
    execFile: (command, args, options, done) => {
      calls.push(args);
      done(null, "", "");
    },
  });
  await assert.rejects(git.read.run("/repo", ["grep", "-Oless", "-e", "x"]), /write surface/);
  await assert.rejects(git.read.run("/repo", ["grep", "--open-files-in-pager=sh", "-e", "x"]), /write surface/);
  await git.read.run("/repo", ["grep", "-n", "-e", "-O", "--", "-Ofile"]);
  assert.deepEqual(calls.at(-1).slice(2), ["grep", "-n", "-e", "-O", "--", "-Ofile"], "a pattern or path that looks like -O is searched for");
});
