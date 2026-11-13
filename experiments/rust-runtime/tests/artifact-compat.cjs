// Production Node client and Artifact store read recorded Node bytes in separate disposable copies.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { createHash } = require("node:crypto");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { connectDesktopRuntime } = require("../../../apps/daemon/src/runtime-client.cjs");
const { createChatArtifacts } = require("../../../packages/core/src/chat-artifacts.cjs");
const processes = new Set();
let stage = "startup";
const deadline = setTimeout(() => {
  for (const child of processes) child.kill("SIGKILL");
  console.error(`Artifact runtime deadline exceeded at ${stage}`);
  process.exitCode = 1;
}, 30000);
function digestTree(root) {
  const digest = createHash("sha256");
  function walk(folder) {
    for (const entry of fs.readdirSync(folder).sort()) {
      if (entry === ".rust-content.lock") continue;
      const file = path.join(folder, entry);
      const stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink());
      digest.update(path.relative(root, file));
      if (stat.isDirectory()) walk(file);
      else {
        assert.ok(stat.isFile());
        digest.update(fs.readFileSync(file));
      }
    }
  }
  walk(root);
  return digest.digest("hex");
}
async function scenario(failure) {
  const oracleRoot = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "milagre-runtime-artifact-oracle-"));
  const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
  processes.add(child);
  child.once("exit", () => processes.delete(child));
  const exited = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "",
    metadata,
    runtime,
    client;
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  try {
    const [line] = await once(lines, "line");
    metadata = JSON.parse(line);
    assert.equal(metadata.ownedCopies, true);
    const project = path.join(metadata.profile, ".projects/alpha");
    const otherProject = path.join(metadata.profile, ".projects/legacy");
    const chatId = `${project}#1`;
    const otherChatId = `${project}#2`;
    const root = path.join(metadata.profile, "artifacts");
    const sourceDigest = digestTree(root);
    const oracleDirectory = path.join(oracleRoot, "artifacts");
    fs.cpSync(root, oracleDirectory, { recursive: true });
    const oracle = createChatArtifacts({
      directory: oracleDirectory,
      validateChat: async (chat) => {
        if (![chatId, otherChatId].includes(chat)) throw new Error("Open an existing Chat before showing a design.");
      },
    });
    client = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
    runtime = await connectDesktopRuntime({ connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }) });
    await assert.rejects(runtime.invoke("artifact:list", [{ chatId }]), { code: "COMMAND_FAILED", message: "Open an existing Chat before showing a design." });
    await runtime.openProject(project);
    await client.call("project:open", [project]);
    await runtime.openProject(otherProject);
    async function compare(method, request) {
      const input = { chatId, ...request };
      let expected;
      try {
        expected = await oracle[method](input);
      } catch (error) {
        await assert.rejects(runtime.invoke(`artifact:${method}`, [input]), { code: "COMMAND_FAILED", message: error.message });
        return;
      }
      assert.deepEqual(await runtime.invoke(`artifact:${method}`, [input]), expected, `${method} ${JSON.stringify(request)}`);
    }
    const beforeState = await runtime.invoke("state:read", [project]);
    stage = "saved HTML, tabs, comments and bounded asset pages";
    for (const request of [{}, { format: "html" }, { format: "design" }, { format: null }, { chatId: otherChatId }]) await compare("list", request);
    for (const request of [
      { id: "report" },
      { id: "report", version: 1 },
      { id: "report", format: "html" },
      { id: "report", fonts: { have: [] } },
      { id: "report", format: "design" },
      { id: "missing" },
      { id: "../report" },
      { id: "report", chatId: otherChatId },
    ])
      await compare("get", request);
    await compare("comments", {});
    await compare("comments", { format: "html" });
    for (const request of [
      { name: "sample.bin", length: 10 },
      { name: "sample.bin", length: Number.MAX_SAFE_INTEGER },
      { name: "sample.bin", offset: 262144 },
      { name: "sample.bin", offset: 307200, length: 99 },
      { name: "sample.bin", offset: 307201 },
      { name: "sample.bin", offset: -1 },
      { name: "sample.bin", length: -1 },
      { name: "caption.txt", length: 20 },
      { name: "missing.bin" },
      { name: "../caption.txt" },
      { name: "sample.bin", chatId: otherChatId },
    ])
      await compare("asset", request);
    const chunk = await runtime.invoke("artifact:asset", [{ chatId, name: "sample.bin", length: Number.MAX_SAFE_INTEGER }]);
    assert.equal(Buffer.from(chunk.base64, "base64").length, 256 * 1024);
    assert.equal(chunk.size, 300 * 1024);
    const current = await runtime.invoke("artifact:get", [{ chatId, id: "report", version: 1 }]);
    assert.equal(current.version, 2);
    assert.deepEqual(
      current.tabs.map((tab) => tab.id),
      ["overview", "details"],
    );
    assert.equal((await runtime.invoke("project:current")).path, otherProject, "Artifact reads leave the viewer's selected Project unchanged");
    assert.equal((await client.call("project:current")).path, project);
    await assert.rejects(runtime.invoke("artifact:get", [{ chatId: `${oracleRoot}#1`, id: "report" }]), {
      code: "COMMAND_FAILED",
      message: "Open an existing Chat before showing a design.",
    });
    await assert.rejects(runtime.invoke("artifact:list", [{ chatId: `${project}#99999` }]), {
      code: "COMMAND_FAILED",
      message: "Open an existing Chat before showing a design.",
    });
    await assert.rejects(runtime.invoke("artifact:delete", [{ chatId, id: "welcome" }]), { code: "UNSUPPORTED_MUTATION" });
    assert.equal(digestTree(root), sourceDigest, "split saved Artifact reads and rejected mutations preserve every content byte");
    assert.deepEqual(await runtime.invoke("state:read", [project]), beforeState, "Artifact reads leave whole Project state and its content revision unchanged");
    stage = `${failure} permanently stops Artifact reads`;
    if (failure === "unsafe-asset") {
      const hash = current.assets.find((asset) => asset.name === "sample.bin").hash;
      const chatHash = createHash("sha256").update(chatId).digest("hex").slice(0, 32);
      const file = path.join(root, chatHash, "report/assets", hash),
        saved = `${file}.saved`;
      fs.renameSync(file, saved);
      fs.mkdirSync(file);
      try {
        await assert.rejects(runtime.invoke("artifact:asset", [{ chatId, name: "sample.bin" }]), { code: "UNSAFE_FILE" });
      } finally {
        fs.rmdirSync(file);
        fs.renameSync(saved, file);
      }
    } else if (failure === "invalid-storage") {
      const chatHash = createHash("sha256").update(chatId).digest("hex").slice(0, 32);
      const file = path.join(root, chatHash, "report/meta.json"),
        saved = `${file}.saved`;
      fs.renameSync(file, saved);
      fs.writeFileSync(file, "{broken json");
      try {
        await assert.rejects(runtime.invoke("artifact:get", [{ chatId, id: "report" }]), { code: "INVALID_CONTENT_STORAGE" });
      } finally {
        fs.unlinkSync(file);
        fs.renameSync(saved, file);
      }
    } else {
      const lock = failure === "project-owner" ? path.join(project, ".milagre/runtime.lock") : path.join(metadata.profile, "artifact-owner.lock");
      // Replace this fixture's owner record without inspecting or logging its secret token.
      const record = path.join(lock, "owner.json"),
        saved = path.join(lock, "owner.saved");
      fs.renameSync(record, saved);
      fs.writeFileSync(record, JSON.stringify({ pid: child.pid, token: "deliberate-isolated-fixture-replacement" }));
      try {
        await assert.rejects(runtime.invoke("artifact:get", [{ chatId, id: "report" }]), { code: "OWNERSHIP_LOST" });
      } finally {
        fs.unlinkSync(record);
        fs.renameSync(saved, record);
      }
    }
    await assert.rejects(runtime.invoke("artifact:list", [{ chatId }]), { code: "CONTENT_OWNER_INACTIVE" });
    assert.equal(digestTree(root), sourceDigest);
  } finally {
    await runtime?.close();
    client?.close();
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    lines.close();
    if (metadata) {
      assert.equal(fs.existsSync(metadata.profile), false);
      assert.equal(fs.existsSync(metadata.socket), false);
    }
    fs.rmSync(oracleRoot, { recursive: true, force: true });
  }
}
(async () => {
  for (const failure of ["artifact-owner", "project-owner", "unsafe-asset", "invalid-storage"]) await scenario(failure);
  console.log(
    "Artifact runtime conformance passed: actual Node HTML/tabs/comments/assets, numeric result pages, Chat scope, both ownership guards, permanent failure latch",
  );
})()
  .catch((error) => {
    console.error(`At ${stage}:`, error);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(deadline));
