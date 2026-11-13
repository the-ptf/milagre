// Run only inert marker helpers in new private local repositories. No network or live config.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync, execFileSync } = require("node:child_process");
const root = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "milagre-git-option-proof-"));
const git = "/usr/bin/git";
const env = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  XDG_CONFIG_HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "file",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
};
const repo = path.join(root, "repo"),
  remote = path.join(root, "remote.git"),
  marker = path.join(root, "marker");
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
function run(args, cwd = repo) {
  return spawnSync(git, ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
  });
}
function must(args, cwd) {
  const out = run(args, cwd);
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}
try {
  fs.mkdirSync(repo, { mode: 0o700 });
  must(["init", "--quiet"], repo);
  must(["init", "--quiet", "--bare", remote], root);
  fs.writeFileSync(path.join(repo, "file"), "one\n");
  must(["add", "file"]);
  must(["commit", "--quiet", "-m", "one"]);
  fs.writeFileSync(path.join(repo, "file"), "two\n");
  must(["add", "file"]);
  must(["commit", "--quiet", "-m", "two"]);
  const head = must(["rev-parse", "HEAD"]),
    cases = [];
  for (const [sub, option] of [
    ["rebase", "--exec"],
    ["fetch", "--upload-pack"],
  ]) {
    for (let end = 3; end <= option.length; end++)
      for (const inline of [false, true]) {
        run(["rebase", "--abort"]);
        must(["reset", "--hard", head]);
        fs.rmSync(marker, { force: true });
        const prefix = option.slice(0, end),
          helper = `/usr/bin/touch ${quote(marker)}${sub === "fetch" ? "; exit 1" : ""}`;
        const args = [sub, ...(inline ? [`${prefix}=${helper}`] : [prefix, helper]), sub === "fetch" ? remote : "HEAD~1"];
        const result = run(args);
        assert.equal(result.error, undefined, "helper command timed out");
        const command = ["git", ...args.map(quote)].join(" ").replaceAll(root, "/isolated");
        cases.push({ command, subcommand: sub, option: prefix, inline, helperExecuted: fs.existsSync(marker), exitCode: result.status });
      }
  }
  assert(cases.some((c) => c.subcommand === "rebase" && c.option === "--exe" && c.helperExecuted));
  assert(cases.some((c) => c.subcommand === "fetch" && c.option === "--upload-p" && c.helperExecuted));
  const target = path.join(__dirname, "../tests/git-abbreviations.json");
  const value = { gitVersion: spawnSync(git, ["--version"], { env, encoding: "utf8" }).stdout.trim(), cases };
  const output = execFileSync(path.resolve(__dirname, "../../../node_modules/.bin/oxfmt"), ["--stdin-filepath", target], {
    input: JSON.stringify(value, null, 2) + "\n",
    encoding: "utf8",
  });
  if (process.argv.includes("--check")) assert.equal(fs.readFileSync(target, "utf8"), output);
  else fs.writeFileSync(target, output);
  console.log(`${cases.length} local option probes, ${cases.filter((c) => c.helperExecuted).length} executed inert markers`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
