// Real production clients and Node content stores, using only fresh fixture profiles.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { connectDesktopRuntime } = require("../../../apps/daemon/src/runtime-client.cjs");
const { createChatArtifacts } = require("../../../packages/core/src/chat-artifacts.cjs");
const { createDesignKits } = require("../../../packages/core/src/design-kits.cjs");

async function main() {
  const oracleRoot = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "milagre-app-content-oracle-"));
  const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "",
    client,
    runtime,
    kits;
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-4096);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    const metadata = JSON.parse((await once(lines, "line"))[0]);
    assert.equal(metadata.appFixture, true);
    const project = metadata.actor.project;
    const chatId = `${project}#1`;
    const peer = `${project}#2`;
    const root = path.join(metadata.profile, "artifacts");
    const kitRoot = path.join(metadata.profile, "design-kits");
    assert.equal(fs.existsSync(path.join(project, "fixture-note.txt")), false);
    fs.cpSync(root, path.join(oracleRoot, "artifacts"), { recursive: true });
    fs.cpSync(kitRoot, path.join(oracleRoot, "design-kits"), { recursive: true });
    kits = createDesignKits({
      directory: path.join(oracleRoot, "design-kits"),
      projectForChat: async (chat) => {
        assert.ok([chatId, peer].includes(chat));
        return project;
      },
    });
    const oracle = createChatArtifacts({
      directory: path.join(oracleRoot, "artifacts"),
      validateChat: async (chat) => {
        assert.ok([chatId, peer].includes(chat));
      },
      readKit: (request) => kits.read(request),
    });
    client = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
    const status = await client.call("daemon:status");
    for (const method of [
      "artifact:list",
      "artifact:get",
      "artifact:asset",
      "artifact:apply",
      "artifact:comments",
      "designs:enabled:read",
      "designs:enabled:save",
    ]) {
      assert.ok(status.methods.includes(method), method);
      await assert.rejects(client.call(method, [{ chatId }]), { code: "ISOLATED_SCOPE_ONLY" });
    }
    runtime = await connectDesktopRuntime({ connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }) });
    await runtime.openProject(project);
    await client.call("project:open", [project]);
    for (const method of ["designs:enabled:read", "designs:enabled:save"]) {
      assert.deepEqual(await runtime.invoke(method, [{ enabled: false }]), { enabled: true });
    }
    async function compare(method, request) {
      const input = { chatId, ...request };
      assert.deepEqual(await runtime.invoke(`artifact:${method}`, [input]), await oracle[method](input));
    }
    for (const input of [{}, { format: "design" }, { format: "html" }, { chatId: peer }]) await compare("list", input);
    for (const input of [{ id: "fixture-report" }, { id: "fixture-screen" }, { id: "fixture-screen", fonts: { have: [] } }]) await compare("get", input);
    await compare("comments", {});
    for (const input of [{ name: "fixture-note.txt" }, { name: "fixture-note.txt", offset: 5, length: 7 }, { name: "fixture-note.txt", offset: 19 }])
      await compare("asset", input);
    const asset = await runtime.invoke("artifact:asset", [{ chatId, name: "fixture-note.txt" }]);
    assert.equal(Buffer.from(asset.base64, "base64").toString(), "Rust fixture asset\n");
    assert.equal((await runtime.invoke("artifact:list", [{ chatId }])).length, 2);
    for (const foreign of [`${oracleRoot}#1`, `${project}#999`]) {
      for (const method of ["artifact:list", "artifact:get", "artifact:asset", "artifact:comments", "artifact:apply"]) {
        await assert.rejects(runtime.invoke(method, [{ chatId: foreign, id: "fixture-screen", name: "fixture-note.txt" }]), { code: "FIXTURE_CHAT_UNKNOWN" });
      }
    }
    await assert.rejects(runtime.invoke("artifact:get", [{ chatId: peer, id: "fixture-screen" }]));
    await assert.rejects(runtime.invoke("artifact:asset", [{ chatId: peer, name: "fixture-note.txt" }]));
    for (const method of ["artifact:delete", "artifact:add-comments"]) {
      assert.equal(status.methods.includes(method), false);
      await assert.rejects(runtime.invoke(method, [{ chatId, id: "fixture-screen", comments: [] }]));
    }
    const before = await runtime.invoke("state:read", [project]);
    const edit = {
      chatId,
      id: "fixture-screen",
      expectedVersion: 1,
      operations: [{ op: "update", id: "heading", patch: { text: "Edited through the Rust app fixture" } }],
    };
    const saved = await runtime.invoke("artifact:apply", [edit]);
    assert.equal(saved.version, 2);
    const chatHash = createHash("sha256").update(chatId).digest("hex").slice(0, 32);
    const metadataFile = path.join(root, chatHash, "fixture-screen/meta.json");
    const timestamp = JSON.parse(fs.readFileSync(metadataFile, "utf8")).versions.find((v) => v.version === 2).createdAt;
    const now = Date.now;
    try {
      Date.now = () => timestamp;
      assert.deepEqual(saved, await oracle.apply(edit), "actual Node source and generated HTML match Rust");
    } finally {
      Date.now = now;
    }
    await compare("get", { id: "fixture-screen" });
    await compare("get", { id: "fixture-screen", version: 1 });
    await assert.rejects(runtime.invoke("artifact:apply", [edit]), { code: "DESIGN_VERSION_CONFLICT" });
    await assert.rejects(oracle.apply(edit), { code: "DESIGN_VERSION_CONFLICT" });
    assert.deepEqual(await runtime.invoke("state:read", [project]), before, "content edits do not mutate Chat state");
    const kept = await runtime.invoke("artifact:get", [{ chatId, id: "fixture-screen" }]);
    runtime.close();
    runtime = await connectDesktopRuntime({ connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }) });
    await runtime.openProject(project);
    assert.deepEqual(await runtime.invoke("artifact:get", [{ chatId, id: "fixture-screen" }]), kept);
    await client.call("project:forget", [project]);
    for (const [method, request] of [
      ["artifact:list", { chatId }],
      ["artifact:get", { chatId, id: "fixture-screen" }],
      ["artifact:asset", { chatId, name: "fixture-note.txt" }],
      ["artifact:comments", { chatId }],
      ["artifact:apply", edit],
      ["designs:enabled:read", {}],
      ["designs:enabled:save", { enabled: false }],
    ]) {
      await assert.rejects(runtime.invoke(method, [request]), { code: "PROJECT_NOT_READY" });
    }
    await runtime.openProject(project);
    assert.deepEqual(await runtime.invoke("artifact:get", [{ chatId, id: "fixture-screen" }]), kept);
    const original = `${project}.retained`;
    assert.equal(stderr, "", "no diagnostic before the intentional ownership-loss probe");
    fs.renameSync(project, original);
    fs.mkdirSync(project, { mode: 0o700 });
    try {
      await assert.rejects(runtime.invoke("artifact:list", [{ chatId }]));
    } finally {
      fs.rmdirSync(project);
      fs.renameSync(original, project);
    }
    await assert.rejects(runtime.invoke("artifact:get", [{ chatId, id: "fixture-screen" }]), { code: "PROJECT_NOT_READY" });
    await runtime.openProject(project);
    assert.deepEqual(await runtime.invoke("artifact:get", [{ chatId, id: "fixture-screen" }]), kept);
    await client.call("daemon:stop");
    client.close();
    runtime.close();
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    // The owner may detect the deliberately replaced root during its periodic
    // whole-state publication before our RPC does. Only that exact diagnostic
    // is allowed; its presence is timing-dependent, readiness revocation is not.
    const ownershipDiagnostic = `isolated owner transition failed: This process no longer owns the Project (the Project folder was replaced: ${project}/.milagre/runtime.lock); nothing was written.\n`;
    assert.ok(stderr === "" || stderr === ownershipDiagnostic, `Unexpected stderr: ${stderr}`);
    assert.equal(fs.existsSync(metadata.profile), false);
    assert.equal(fs.existsSync(metadata.socket), false);
    console.log("app content conformance passed");
  } finally {
    client?.close();
    runtime?.close();
    kits?.dispose?.();
    lines.close();
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    fs.rmSync(oracleRoot, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
