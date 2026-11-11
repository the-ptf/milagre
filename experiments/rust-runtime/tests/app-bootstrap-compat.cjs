const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { acquireOwnership } = require("../../../packages/core/src/ownership.cjs");
const fixture = require("../fixtures/app-bootstrap.json");
async function until(label, check) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Timed out: " + label);
}
async function main() {
  const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-4096)));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
  let client, metadata;
  try {
    const receipt = (await once(lines, "line"))[0];
    assert.ok(Buffer.byteLength(receipt) + 1 <= 4096);
    metadata = JSON.parse(receipt);
    assert.equal(metadata.appFixture, true);
    assert.equal(metadata.bootstrapVersion, 1);
    assert.equal(metadata.protocolVersion, 1);
    assert.equal(metadata.pid, child.pid);
    assert.equal(metadata.uid, process.getuid());
    const project = metadata.actor.project;
    for (const [name, file, kind] of [
      ["profile", metadata.profile, "directory"],
      ["project", project, "directory"],
      ["socketDirectory", path.dirname(metadata.socket), "directory"],
      ["socket", metadata.socket, "socket"],
    ]) {
      const stat = fs.lstatSync(file, { bigint: true });
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(kind === "socket" ? stat.isSocket() : stat.isDirectory(), true);
      assert.deepEqual(metadata.identities[name], {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        mode: Number(stat.mode & 0o7777n),
        uid: Number(stat.uid),
        kind,
      });
    }
    assert.equal(metadata.identities.profile.mode, 0o700);
    assert.equal(metadata.identities.socketDirectory.mode, 0o700);
    assert.equal(metadata.identities.socket.mode, 0o600);
    assert.equal(path.dirname(project), metadata.profile);
    assert.equal(metadata.actor.handoff, "gated");
    assert.equal(metadata.actor.steering, "gated");
    const lock = path.join(project, ".milagre/runtime.lock");
    const originalOwner = fs.readFileSync(path.join(lock, "owner.json"));
    assert.throws(() => acquireOwnership(lock), /owned|running|already|another/i);
    assert.deepEqual(fs.readFileSync(path.join(lock, "owner.json")), originalOwner, "Node refusal changes no owner bytes");
    client = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
    const status = await client.call("daemon:status");
    assert.equal(status.pid, child.pid);
    for (const missing of ["worktree:create", "accounts:login", "accounts:assign", "usage:read", "terminal:open", "link:create"]) {
      assert.equal(status.methods.includes(missing), false, missing);
      await assert.rejects(client.call(missing, []));
    }
    function expand(value) {
      return JSON.parse(JSON.stringify(value).replaceAll("$PROJECT", project));
    }
    for (const test of fixture.cases) {
      const result = await client.call(test.method, expand(test.args));
      if (test.method === "project:read") {
        assert.equal(typeof result.version, "number");
        assert.equal(typeof result.epoch, "string");
        delete result.version;
        delete result.epoch;
      }
      assert.deepEqual(result, expand(test.result), test.method);
    }
    await assert.rejects(client.call("chat:send", [{ projectPath: project, sessionId: 2, provider: "kiro", model: "real-model", body: "never" }]), {
      code: "FIXTURE_UNSUPPORTED",
    });
    const before = await client.call("project:read", [project, { state: false }]);
    const complete = await client.call("project:read", [project]);
    assert.equal(before.version, complete.version);
    assert.equal(before.epoch, complete.epoch);
    assert.equal(before.state, undefined);
    assert.deepEqual(complete.state, (await client.call("state:read", [project])).state);
    await assert.rejects(client.call("accounts:list", [true]), { code: "FIXTURE_UNSUPPORTED" });
    await assert.rejects(client.call("accounts:scope", [project, true]), { code: "FIXTURE_UNSUPPORTED" });
    for (const method of ["project:read", "accounts:scope", "agent:models", "agent:cli-status"])
      await assert.rejects(client.call(method, [process.cwd()]), { code: "ISOLATED_SCOPE_ONLY" });
    const readCases = fixture.cases.map((c) => [c.method, expand(c.args)]);
    await client.call("project:forget", [project]);
    for (const [method, args] of readCases) await assert.rejects(client.call(method, args), { code: "PROJECT_NOT_READY" }, method);
    assert.deepEqual((await client.call("daemon:snapshot")).projects, []);
    await client.call("project:open", [project]);
    const hidden = project + ".held";
    fs.renameSync(project, hidden);
    fs.mkdirSync(project);
    try {
      for (const [method, args] of readCases) await assert.rejects(client.call(method, args), method);
      assert.deepEqual((await client.call("daemon:snapshot")).projects, []);
    } finally {
      fs.rmdirSync(project);
      fs.renameSync(hidden, project);
    }
    for (const [method, args] of readCases) await assert.rejects(client.call(method, args), { code: "PROJECT_NOT_READY" }, method);
    await client.call("project:open", [project]);
    // Registry file identity/contents are pinned, never adopted from replacement metadata.
    const registry = fs.readdirSync(metadata.profile).find((name) => name.startsWith("registry-copy-"));
    const file = path.join(metadata.profile, registry, "project-registry.json");
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, "{}");
    try {
      await assert.rejects(client.call("project:registry"), { code: "FIXTURE_BOOTSTRAP_INVALID" });
    } finally {
      fs.writeFileSync(file, bytes);
    }
    assert.deepEqual(await client.call("project:registry"), expand(fixture.registry.projects));
    await client.call("chat:send", [
      { projectPath: project, sessionId: 2, provider: "kiro", model: "scripted", body: "fixture:blocked-start", clientMessageId: "bootstrap-run" },
    ]);
    await until("owner run visible", async () => Boolean((await client.call("chat:runs")).runs[project + "#2"]));
    // The blocked fixture emits exactly one session-started event after send admission.
    // Observe its fold before comparing two separate RPC snapshots; otherwise that
    // legitimate event can advance seq between the reads.
    await until("scripted session-started folded", async () => {
      const { state } = await client.call("state:read", [project]);
      return state.sessions["2"].native_session_id === "fixture-" + project + "#2";
    });
    const runs = await client.call("chat:runs");
    assert.deepEqual(runs, (await client.call("daemon:snapshot")).runs);
    await client.call("agent:interrupt", [project + "#2"]);
    await until("owner run ended", async () => !(await client.call("chat:runs")).runs[project + "#2"]);
    await client.call("daemon:stop");
    client.close();
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(fs.existsSync(metadata.profile), false);
    console.log("bootstrap conformance passed");
  } finally {
    client?.close();
    lines.close();
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
