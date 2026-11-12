// Actual normal runtime and production Node client. Only captured synthetic gh runs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const binary = path.resolve(process.argv[2]);
const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-pr-details-wire-")));
const active = new Set();
let completed = false;
const bound = (promise, label, ms = 12000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
async function waitFor(check, label) {
  const by = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < by, label);
    await new Promise((r) => setTimeout(r, 2));
  }
}
const ghCalls = () =>
  fs.existsSync(path.join(parent, "calls.jsonl"))
    ? fs.readFileSync(path.join(parent, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
async function launch(root, manifest) {
  const child = spawn(binary, manifest ? ["create", root, manifest] : ["open", root], { stdio: ["pipe", "pipe", "pipe"] });
  active.add(child);
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      active.delete(child);
      resolve({ code, signal });
    });
  });
  const lines = readline.createInterface({ input: child.stdout });
  const receipt = await bound(
    Promise.race([
      new Promise((resolve) => lines.once("line", (line) => resolve(JSON.parse(line)))),
      exit.then(() => {
        throw Error(stderr);
      }),
    ]),
    "receipt",
  );
  lines.close();
  const client = await connect({ dataDir: receipt.profile, timeoutMs: 8000 });
  return { child, exit, receipt, client, root, project: receipt.actor.project, stderr: () => stderr };
}
async function open(r) {
  await r.client.call("project:open", [r.project]);
}
async function stop(r, control = r.client) {
  for (const until = Date.now() + 10000; ;) {
    try {
      await control.call("daemon:stop");
      break;
    } catch (e) {
      assert.equal(e.code, "QUIT_PENDING");
      assert.ok(Date.now() < until, "retained read cleanup");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  r.client.close();
  if (control !== r.client) control.close();
  r.child.stdin.end();
  assert.deepEqual(await bound(r.exit, "normal exit"), { code: 0, signal: null }, r.stderr());
  assert.equal(r.stderr(), "");
  assert.equal(fs.existsSync(r.receipt.profile), false);
  assert.equal(fs.existsSync(r.receipt.socket), false);
  assert.equal(fs.existsSync(path.join(r.project, ".milagre/runtime.lock")), false);
  assert.equal(fs.existsSync(r.root), true);
}
async function main() {
  for (const name of ["home", "account", "gh-home", "gh-account"]) fs.mkdirSync(path.join(parent, name), { mode: 0o700 });
  for (const name of ["hosts.yml", "config.yml"]) fs.writeFileSync(path.join(parent, "gh-account", name), "synthetic account metadata\n", { mode: 0o600 });
  const provider = path.join(parent, "never-provider");
  fs.writeFileSync(provider, `#!/bin/sh\necho forbidden > '${path.join(parent, "provider-ran")}'\nexit 99\n`, { mode: 0o700 });
  const fake = path.join(parent, "fake-gh.py");
  fs.writeFileSync(
    fake,
    `import os,sys,json,time
assert sys.argv[1:5]==['api','graphql','--hostname','github.com']
assert 'owner=example' in sys.argv and 'name=repo' in sys.argv
assert any(s.startswith('query=') and 'viewer { login }' in s for s in sys.argv)
assert os.environ['GH_CONFIG_DIR']==${JSON.stringify(path.join(parent, "gh-account"))}
assert os.environ['HOME']==${JSON.stringify(path.join(parent, "gh-home"))}
assert not any(k in os.environ for k in ['GH_TOKEN','GITHUB_TOKEN','SSH_AUTH_SOCK','NODE_OPTIONS'])
base=${JSON.stringify(parent)}
with open(base+'/calls.jsonl','a') as f:f.write(json.dumps({'pid':os.getpid(),'args':sys.argv[1:]})+chr(10))
while os.path.exists(base+'/hold'):time.sleep(.002)
if os.path.exists(base+'/auth-fail'):
  sys.stderr.write('gh: To get started with GitHub CLI, please run:  gh auth login'+chr(10));sys.exit(4)
login='bob' if os.path.exists(base+'/wrong-viewer') else 'alice'
number=int([a for a in sys.argv if a.startswith('number=')][0].split('=')[1])
head=open(base+'/head-oid').read().strip() if os.path.exists(base+'/head-oid') else '2'*40
print(json.dumps({'data':{'viewer':{'login':login},'repository':{'pullRequest':{'number':number,'title':'Actual synthetic PR','state':'OPEN','baseRefOid':'1'*40,'headRefOid':head,'files':{'nodes':[{'path':'src.rs','additions':1,'deletions':0,'changeType':'MODIFIED'}],'pageInfo':{'hasNextPage':False}},'checks':{'nodes':[{'commit':{'statusCheckRollup':{'contexts':{'nodes':[{'kind':'CheckRun','name':'unit','status':'COMPLETED','conclusion':'SUCCESS'}]}}}}]}}}}}))
`,
    { mode: 0o600 },
  );
  const gh = path.join(parent, "gh");
  fs.writeFileSync(gh, `#!/bin/sh\nexec /usr/bin/python3 '${fake}' "$@"\n`, { mode: 0o700 });
  const config = {
    program: provider,
    home: path.join(parent, "home"),
    configDirectory: path.join(parent, "account"),
    skillsDirectory: path.resolve("../../packages/core/src/bundled-skills"),
    model: "sonnet",
    path: "/usr/bin:/bin",
    accountId: "11111111-1111-4111-8111-111111111111",
    accountLabel: "Synthetic Claude",
    userName: "synthetic-test",
  };
  const launch = path.join(parent, "launch.json");
  fs.writeFileSync(launch, JSON.stringify(config), { mode: 0o600 });
  const absent = await launchRuntime(path.join(parent, "ungranted"), launch);
  const absentStatus = await absent.client.call("daemon:status");
  assert.equal(absentStatus.methods.includes("pr:detail"), false);
  await open(absent);
  await assert.rejects(
    absent.client.call("pr:detail", [{ cwd: absent.project, number: 12 }]),
    (e) => e.code === "COMMAND_FAILED" && e.message === "Unknown command: pr:detail",
  );
  await stop(absent);
  assert.equal(ghCalls().length, 0);
  config.githubRead = {
    program: gh,
    home: path.join(parent, "gh-home"),
    configDirectory: path.join(parent, "gh-account"),
    path: "/usr/bin:/bin",
    accountLogin: "alice",
    owner: "example",
    repository: "repo",
  };
  fs.writeFileSync(launch, JSON.stringify(config), { mode: 0o600 });
  const root = path.join(parent, "granted");
  const first = await launchRuntime(root, launch);
  assert.equal(ghCalls().length, 0, "capture must not perform a startup probe");
  assert.equal((await first.client.call("daemon:status")).methods.includes("pr:detail"), true);
  await assert.rejects(first.client.call("pr:detail", [{ cwd: first.project, number: 12 }]), { code: "ISOLATED_SCOPE_ONLY" });
  await open(first);
  const control = await connect({ dataDir: first.receipt.profile, timeoutMs: 8000 });
  await control.call("project:open", [first.project]);
  const joiner = await connect({ dataDir: first.receipt.profile, timeoutMs: 8000 });
  await joiner.call("project:open", [first.project]);
  const queuer = await connect({ dataDir: first.receipt.profile, timeoutMs: 8000 });
  await queuer.call("project:open", [first.project]);
  const before = ghCalls().length;
  fs.writeFileSync(path.join(parent, "hold"), "");
  const pending = first.client.call("pr:detail", [{ cwd: first.project, number: 12 }]);
  await waitFor(() => ghCalls().length > before, "fake gh entered");
  // The same PR joins the read in flight; another PR queues behind it instead of being refused.
  const joined = joiner.call("pr:detail", [{ cwd: first.project, number: 12 }]);
  const queued = queuer.call("pr:detail", [{ cwd: first.project, number: 13 }]);
  try {
    await bound(control.call("chat:runs", []), "actor must remain responsive while PR reads wait", 1000);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(ghCalls().length, before + 1, "joined and queued reads must not start a second child while the first is held");
  } finally {
    fs.unlinkSync(path.join(parent, "hold"));
  }
  const detail = await pending;
  assert.equal(detail.ok, true);
  assert.equal(detail.pr.number, 12);
  assert.equal(detail.pr.baseRefOid, "1".repeat(40));
  assert.equal(detail.pr.headRefOid, "2".repeat(40));
  assert.equal(detail.pr.checks[0].outcome, "pass");
  assert.deepEqual(await joined, detail, "a joined read gets the same result");
  const other = await queued;
  assert.equal(other.ok, true);
  assert.equal(other.pr.number, 13);
  assert.equal(ghCalls().length, before + 2, "one child for PR 12, one for PR 13");
  // A client that goes away while its read is held: the child is reaped, not kept for 30 seconds.
  const goner = await connect({ dataDir: first.receipt.profile, timeoutMs: 8000 });
  await goner.call("project:open", [first.project]);
  const goneBefore = ghCalls().length;
  fs.writeFileSync(path.join(parent, "hold"), "");
  goner.call("pr:detail", [{ cwd: first.project, number: 14 }]).catch(() => {});
  await waitFor(() => ghCalls().length > goneBefore, "departing client gh entered");
  const gonePid = ghCalls().at(-1).pid;
  goner.close();
  await waitFor(
    () => spawnSync("/bin/ps", ["-p", String(gonePid), "-o", "pid="]).status !== 0,
    "a departed client must not keep its gh child while nobody waits",
  );
  fs.unlinkSync(path.join(parent, "hold"));
  for (const extra of [joiner, queuer]) extra.close();
  const calls = ghCalls().length;
  await assert.rejects(first.client.call("pr:detail", [{ cwd: parent, number: 12 }]), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(await first.client.call("pr:detail", [{ cwd: first.project, number: "12" }]), { ok: false, message: "That isn't a PR number." });
  assert.equal(ghCalls().length, calls);
  const blockedBefore = ghCalls().length;
  fs.writeFileSync(path.join(parent, "hold"), "");
  const blocked = first.client.call("pr:detail", [{ cwd: first.project, number: 12 }]).then(
    () => ({ unexpected: true }),
    (e) => ({ code: e.code }),
  );
  await waitFor(() => ghCalls().length > blockedBefore, "blocked gh entered");
  const pid = ghCalls().at(-1).pid;
  await stop(first, control);
  assert.equal((await blocked).unexpected, undefined);
  assert.notEqual(spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid="]).status, 0, "stop must reap actual retained gh child");
  fs.unlinkSync(path.join(parent, "hold"));
  const second = await launchRuntime(root);
  await open(second);
  assert.deepEqual(await second.client.call("pr:detail", [{ cwd: second.project, number: 12 }]), detail);
  const beforeRewrite = ghCalls().length;
  fs.writeFileSync(path.join(parent, "gh-account/hosts.yml"), "changed synthetic metadata\n");
  // `gh auth login` rewrote the account files: the next read adopts them and proves the viewer again.
  const adopted = await second.client.call("pr:detail", [{ cwd: second.project, number: 12 }]);
  assert.equal(adopted.ok, true);
  assert.ok(ghCalls().length > beforeRewrite);
  await stop(second);
  const third = await launchRuntime(root);
  await open(third);
  fs.writeFileSync(path.join(parent, "wrong-viewer"), "");
  const read = () => third.client.call("pr:detail", [{ cwd: third.project, number: 12 }]);
  await assert.rejects(read(), { code: "PR_ACCOUNT_NOT_READY" });
  const afterMismatch = ghCalls().length;
  await assert.rejects(read(), { code: "PR_ACCOUNT_NOT_READY" });
  assert.ok(ghCalls().length > afterMismatch, "a later read must prove the viewer again");
  fs.unlinkSync(path.join(parent, "wrong-viewer"));
  assert.equal((await read()).ok, true, "the right account recovers without a restart");
  // Signed out: Node's own result, then recovery.
  const login = `Sign in to GitHub on ${process.platform === "darwin" ? "this Mac" : "this computer"} with \`gh auth login\`, then try again.`;
  fs.writeFileSync(path.join(parent, "auth-fail"), "");
  assert.deepEqual(await read(), { ok: false, message: login });
  fs.unlinkSync(path.join(parent, "auth-fail"));
  assert.equal((await read()).ok, true);
  // localCommits through the bounded Git reader: the real repository's HEAD is two commits past the PR head.
  const gitEnv = {
    PATH: "/usr/bin:/bin",
    HOME: parent,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Synthetic",
    GIT_AUTHOR_EMAIL: "s@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic",
    GIT_COMMITTER_EMAIL: "s@example.invalid",
  };
  const git = (...args) => {
    const r = spawnSync("/usr/bin/git", args, { cwd: third.project, env: gitEnv, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-b", "main");
  const shas = [];
  for (let n = 0; n < 4; n++) {
    fs.writeFileSync(path.join(third.project, "tracked.txt"), `${n}\n`);
    git("add", "tracked.txt");
    git("commit", "-m", `c${n}`);
    shas.push(git("rev-parse", "HEAD"));
  }
  assert.equal((await read()).pr.localCommits, undefined, "a PR head this checkout lacks reports no local commits, as Node does");
  fs.writeFileSync(path.join(parent, "head-oid"), shas[1]);
  assert.equal((await read()).pr.localCommits, 2);
  await stop(third);
  assert.equal(fs.existsSync(path.join(parent, "provider-ran")), false);
  console.log(JSON.stringify({ ok: true, readOnly: true, noProviderCalls: true, actorResponsive: true, identityObserved: true, cleanup: true }));
  completed = true;
}
const launchRuntime = launch;
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      fs.unlinkSync(path.join(parent, "hold"));
    } catch {}
    for (const child of active) child.stdin.end();
    if (completed) fs.rmSync(parent, { recursive: true, force: true });
    else console.error(`Retained synthetic PR evidence: ${parent}`);
  });
