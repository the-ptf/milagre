// Real Node runtime client drives native saved Design edits in disposable owned Rust copies.
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
const { createDesignKits } = require("../../../packages/core/src/design-kits.cjs");
const processes = new Set();
let stage = "startup";
const deadline = setTimeout(() => {
  for (const child of processes) child.kill("SIGKILL");
  console.error(`Design runtime deadline exceeded at ${stage}`);
  process.exitCode = 1;
}, 30000);
function files(root) {
  const found = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".rust-content.lock") continue;
      const file = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) walk(file);
      else {
        assert.ok(entry.isFile());
        found[path.relative(root, file)] =
          entry.name === "meta.json" ? JSON.parse(fs.readFileSync(file, "utf8")) : createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      }
    }
  }
  walk(root);
  return found;
}
async function scenario(failure) {
  const oracleRoot = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "milagre-runtime-design-oracle-"));
  const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
  processes.add(child);
  child.once("exit", () => processes.delete(child));
  const exited = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "",
    metadata,
    runtime,
    client,
    kits;
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
    const root = path.join(metadata.profile, "artifacts");
    const kitRoot = path.join(metadata.profile, "design-kits");
    const sourceBefore = files(root);
    const kitsBefore = files(kitRoot);
    const oracleDirectory = path.join(oracleRoot, "artifacts");
    const oracleKits = path.join(oracleRoot, "design-kits");
    fs.cpSync(root, oracleDirectory, { recursive: true });
    fs.cpSync(kitRoot, oracleKits, { recursive: true });
    kits = createDesignKits({
      directory: oracleKits,
      projectForChat: async (chat) => {
        assert.equal(chat, chatId);
        return project;
      },
    });
    const oracle = createChatArtifacts({
      directory: oracleDirectory,
      validateChat: async (chat) => assert.equal(chat, chatId),
      readKit: (request) => kits.read(request),
    });
    client = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
    runtime = await connectDesktopRuntime({ connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }) });
    assert.deepEqual(await runtime.invoke("designs:enabled:read"), { enabled: true });
    assert.deepEqual(await runtime.invoke("designs:enabled:save", [{ enabled: false }]), { enabled: true });
    const request = {
      chatId,
      id: "welcome",
      expectedVersion: 1,
      operations: [{ op: "update", id: "heading", patch: { text: "Edited by the Rust runtime 🦀" } }],
    };
    await assert.rejects(runtime.invoke("artifact:apply", [request]), { code: "COMMAND_FAILED", message: "Open an existing Chat before showing a design." });
    await runtime.openProject(project);
    await client.call("project:open", [project]);
    await runtime.openProject(otherProject);
    const beforeState = await runtime.invoke("state:read", [project]);
    const before = await runtime.invoke("artifact:get", [{ chatId, id: "welcome" }]);
    assert.deepEqual(before, await oracle.get({ chatId, id: "welcome" }));
    assert.equal(before.document.kit.version, 1);
    assert.equal((await kits.read({ chatId })).version, 2);
    if (failure) {
      stage = `${failure} forbids Design commit and latches owner inactive`;
      const file = failure.startsWith("kit-")
        ? path.join(kitRoot, createHash("sha256").update(project).digest("hex"), "project.json")
        : path.join(project, ".milagre/runtime.lock/owner.json");
      const saved = `${file}.saved`;
      fs.renameSync(file, saved);
      fs.writeFileSync(
        file,
        failure === "kit-storage"
          ? "{broken kit"
          : failure === "kit-schema"
            ? JSON.stringify([{ id: "project", version: 1, title: null }])
            : JSON.stringify({ pid: child.pid, token: "isolated-design-test-replacement" }),
      );
      try {
        await assert.rejects(runtime.invoke("artifact:apply", [request]), { code: failure.startsWith("kit-") ? "INVALID_CONTENT_STORAGE" : "OWNERSHIP_LOST" });
      } finally {
        fs.unlinkSync(file);
        fs.renameSync(saved, file);
      }
      await assert.rejects(runtime.invoke("artifact:apply", [request]), { code: "CONTENT_OWNER_INACTIVE" });
      assert.deepEqual(files(root), sourceBefore, "rejected writes cannot create a source or preview revision");
      assert.deepEqual(files(kitRoot), kitsBefore);
      return;
    }
    async function compareApply(input, actual) {
      actual ??= await runtime.invoke("artifact:apply", [input]);
      const previousNow = Date.now;
      const chatHash = createHash("sha256").update(chatId).digest("hex").slice(0, 32);
      const savedMetadata = JSON.parse(fs.readFileSync(path.join(root, chatHash, "welcome/meta.json"), "utf8"));
      const timestamp = savedMetadata.versions.find((entry) => entry.version === actual.version).createdAt;
      assert.ok(Number.isSafeInteger(timestamp));
      Date.now = () => timestamp;
      let expected;
      try {
        expected = await oracle.apply(input);
      } finally {
        Date.now = previousNow;
      }
      assert.deepEqual(actual, expected, "native source and freshly rendered HTML match the actual Node apply result");
      return actual;
    }
    stage = "existing UI font-cache misses and hits";
    const cachedRequest = { chatId, id: "welcome", fonts: { have: [] } };
    const cached = await runtime.invoke("artifact:get", [cachedRequest]);
    assert.deepEqual(cached, await oracle.get(cachedRequest));
    assert.match(cached.fontKey, /^[a-f0-9]{64}$/);
    assert.ok(cached.fontCss.includes("data:font/ttf;base64,"));
    assert.ok(cached.html.length < before.html.length);
    const hitRequest = { ...cachedRequest, fonts: { have: [cached.fontKey] } };
    const hit = await runtime.invoke("artifact:get", [hitRequest]);
    assert.deepEqual(hit, await oracle.get(hitRequest));
    assert.equal(Object.hasOwn(hit, "fontCss"), false);
    stage = "one native Design revision and retained source/preview";
    const edited = await compareApply(request);
    assert.equal(edited.version, 2);
    assert.equal(edited.latest, 2);
    assert.equal(edited.document.nodes[0].text, request.operations[0].patch.text);
    assert.equal(edited.document.kit.version, 1);
    assert.ok(edited.html.includes("data:font/ttf;base64,"));
    assert.ok(edited.html.includes("Edited by the Rust runtime"));
    assert.ok(edited.html.length > 4096, "real renderer output must cross the paged wire boundary");
    assert.deepEqual(await runtime.invoke("artifact:get", [{ chatId, id: "welcome", version: 1 }]), await oracle.get({ chatId, id: "welcome", version: 1 }));
    await assert.rejects(runtime.invoke("artifact:apply", [request]), { code: "DESIGN_VERSION_CONFLICT" });
    const invalidKit = structuredClone(before.document.kit);
    invalidKit.colors.ink = "#111111";
    await assert.rejects(runtime.invoke("artifact:apply", [{ ...request, expectedVersion: 2, operations: [{ op: "document", patch: { kit: invalidKit } }] }]), {
      code: "COMMAND_FAILED",
      message: "The pinned kit differs from this Project's saved version. Read it with design_kit_read and use that snapshot.",
    });
    await assert.rejects(runtime.invoke("artifact:apply", [{ ...request, chatId: `${project}#999999`, expectedVersion: 2 }]), { code: "COMMAND_FAILED" });
    await assert.rejects(runtime.invoke("artifact:apply", [{ ...request, id: "report", expectedVersion: 2 }]), {
      code: "COMMAND_FAILED",
      message: "Artifacts and Designs use separate formats. Create a new id instead of changing formats.",
    });
    stage = "concurrent optimistic edits create exactly one fresh revision";
    const requests = ["First viewer", "Second viewer"].map((text) => ({
      ...request,
      expectedVersion: 2,
      operations: [{ op: "update", id: "heading", patch: { text } }],
    }));
    const race = await Promise.allSettled([runtime.invoke("artifact:apply", [requests[0]]), client.call("artifact:apply", [requests[1]])]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    const winner = race.findIndex((result) => result.status === "fulfilled");
    assert.equal(race[1 - winner].reason.code, "DESIGN_VERSION_CONFLICT");
    await compareApply(requests[winner], race[winner].value);
    const kit2 = await kits.read({ chatId });
    await compareApply({ ...request, expectedVersion: 3, operations: [{ op: "document", patch: { kit: kit2 } }] });
    const current = await runtime.invoke("artifact:get", [{ chatId, id: "welcome" }]);
    assert.deepEqual(current, await oracle.get({ chatId, id: "welcome" }));
    assert.equal(current.version, 4);
    assert.equal(current.document.kit.version, 2);
    assert.deepEqual(await runtime.invoke("artifact:list", [{ chatId, format: "design" }]), await oracle.list({ chatId, format: "design" }));
    assert.deepEqual(files(root), files(oracleDirectory), "saved metadata values, source bytes and rendered preview bytes match Node");
    assert.deepEqual(files(kitRoot), kitsBefore, "Design edits never mutate pinned Project kit snapshots");
    assert.deepEqual(await runtime.invoke("state:read", [project]), beforeState, "Design revisions do not alter Project whole-state content/version");
    assert.equal((await runtime.invoke("project:current")).path, otherProject);
    assert.equal((await client.call("project:current")).path, project);
    await runtime.close();
    runtime = await connectDesktopRuntime({ connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }) });
    assert.deepEqual(await runtime.invoke("artifact:get", [{ chatId, id: "welcome" }]), current, "reconnected viewer reads the saved native revision");
  } finally {
    await runtime?.close();
    client?.close();
    await kits?.close();
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
  for (const failure of [null, "kit-storage", "kit-schema", "project-owner"]) await scenario(failure);
  console.log(
    "Design runtime conformance passed: native kit validation, real HTML/font renderer, paged edits, concurrent conflicts, retained revisions, reconnect, failed-write ownership guard",
  );
})()
  .catch((error) => {
    console.error(`At ${stage}:`, error);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(deadline));
