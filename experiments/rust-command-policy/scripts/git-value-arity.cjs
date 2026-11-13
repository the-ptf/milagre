// Differential option-arity proof. All Git writes are inside new private synthetic repos.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { spawnSync, execFileSync } = require("node:child_process");
const root = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "milagre-git-arity-proof-"));
const repo = path.join(root, "repo"),
  remote = path.join(root, "remote.git"),
  marker = path.join(root, "marker"),
  helper = path.join(root, "marker-helper");
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
  GIT_EDITOR: "/usr/bin/false",
  GIT_SEQUENCE_EDITOR: "/usr/bin/false",
  GIT_PAGER: "/bin/cat",
  PAGER: "/bin/cat",
};
const git = "/usr/bin/git",
  probe = "--zz-probe-flag";
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
function run(args, cwd = repo, monitor = false) {
  return spawnSync(
    git,
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...(monitor ? [] : ["-c", "core.fsmonitor=false"]), ...args],
    { cwd, env, input: "", encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
  );
}
function must(args, cwd) {
  const out = run(args, cwd);
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}
const unknownProbe = (text) => /(?:unknown|unrecognized|invalid) (?:option|argument|switch)[^\n]*zz-probe-flag/i.test(text);
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
  const head = must(["rev-parse", "HEAD"]);
  const forms = JSON.parse(fs.readFileSync(path.join(__dirname, "../tests/accepted-git-options.json"), "utf8")).filter(
    (row) => row.kind === "values" || row.kind === "inline-only",
  );
  forms.push({ subcommand: "diff", flag: "-U", kind: "inline-only" });
  const cases = [];
  for (const row of forms) {
    run(["rebase", "--abort"]);
    must(["reset", "--hard", head]);
    const prefix = [row.subcommand, ...(row.subcommand === "subtree" ? ["push"] : [])];
    const tail =
      row.subcommand === "fetch"
        ? [remote]
        : row.subcommand === "blame"
          ? ["file"]
          : row.subcommand === "tag"
            ? ["fixture-tag"]
            : ["ls-tree", "merge", "cherry-pick", "rev-list"].includes(row.subcommand)
              ? ["HEAD"]
              : row.subcommand === "rebase"
                ? ["HEAD~1"]
                : [];
    const args = [...prefix, row.flag, probe, ...tail];
    const result = run(args),
      control = run([...prefix, probe, ...tail]);
    assert.equal(result.error, undefined);
    assert.equal(control.error, undefined);
    const diagnostic = (result.stderr || result.stdout).split("\n").find(Boolean) || "";
    const unknownAny = /(?:unknown|unrecognized|invalid) (?:option|argument|switch)\b/i.test(result.stderr + result.stdout);
    const probeConsumed = !unknownAny && (result.status !== control.status || result.stderr !== control.stderr || result.stdout !== control.stdout);
    if (row.kind === "values") assert(probeConsumed, `Git did not consume the value: ${row.subcommand} ${row.flag}`);
    else assert(!probeConsumed, `inline-only option consumed next token: ${row.subcommand} ${row.flag}`);
    cases.push({
      subcommand: row.subcommand,
      flag: row.flag,
      mode: row.kind,
      probeConsumed,
      command: ["git", ...args.map(quote)].join(" ").replaceAll(root, "/isolated"),
      probeParsedAsOption: unknownProbe(result.stderr + result.stdout),
      controlParsedAsOption: unknownProbe(control.stderr + control.stdout),
      controlDiagnostic: (control.stderr || control.stdout).split("\n").find(Boolean) || "",
      diagnostic: diagnostic.replaceAll(root, "/isolated"),
      exitCode: result.status,
    });
  }
  // Reproduce the complete reported configuration-write chain with an inert private helper.
  fs.writeFileSync(helper, `#!/bin/sh\n/usr/bin/touch ${quote(marker)}\n`, { mode: 0o700 });
  const formatting = `--format=[core]%n%x09fsmonitor = ${helper}`;
  const first = ["log", "-1", "--pretty", "--output=.git/config", formatting];
  const write = run(first, repo, true);
  assert.equal(write.status, 0, write.stderr);
  const config = fs.readFileSync(path.join(repo, ".git/config"), "utf8");
  assert(config.includes(`fsmonitor = ${helper}`));
  run(["status", "--short"], repo, true);
  assert(fs.existsSync(marker), "inert fsmonitor helper did not execute");
  const chain = {
    command: ["git", ...first.map(quote)].join(" ").replaceAll(root, "/isolated") + " && git status --short",
    configWritten: true,
    helperExecuted: true,
  };
  const value = { gitVersion: spawnSync(git, ["--version"], { env, encoding: "utf8" }).stdout.trim(), cases, chain };
  const target = path.join(__dirname, "../tests/git-value-arity.json");
  const output = execFileSync(path.resolve(__dirname, "../../../node_modules/.bin/oxfmt"), ["--stdin-filepath", target], {
    input: JSON.stringify(value, null, 2) + "\n",
    encoding: "utf8",
  });
  if (process.argv.includes("--check")) assert.equal(fs.readFileSync(target, "utf8"), output);
  else fs.writeFileSync(target, output);
  console.log(`${cases.length} option-arity probes; config-write chain executed inert marker`);
  for (const c of cases) if (c.mode === "values" && c.probeParsedAsOption) console.log(`WRONG VALUE ARITY ${c.subcommand} ${c.flag}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
