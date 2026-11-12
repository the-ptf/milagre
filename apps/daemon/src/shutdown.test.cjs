const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { connect } = require("./client.cjs");
const { startDaemon } = require("./server.cjs");
const { once } = require("node:events");

test("stop acknowledges with pending PR reads, preserves accepted Chat changes, and tolerates repeated cleanup", { timeout: 60000 }, async () => {
  // macOS's temporary directory can be an alias; commands must use the same canonical scope as project:open.
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-stop-pending-")));
  const project = path.join(directory, "project");
  const dataDir = path.join(directory, "profile");
  const request = Promise.withResolvers();
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  await fs.mkdir(path.join(project, ".milagre"), { recursive: true });
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const messages = [{ id: 3, session_id: 2, role: "user", body: "Keep the saved Chat", context: null }];
  await fs.writeFile(
    path.join(project, ".milagre", "coordination.json"),
    JSON.stringify({
      next_id: 4,
      projects: { 1: { id: 1, name: "project" } },
      worktrees: { 1: { id: 1, project_id: 1, path: project, name: "main" } },
      sessions: { 2: { id: 2, worktree_id: 1, agent_name: "main", status: "Created", title: "Saved Chat", provider: "codex" } },
      messages,
    }),
  );
  const daemon = await startDaemon({
    dataDir,
    version: "0.1.0",
    runtimeOptions: {
      cwd: project,
      chatsHome: path.join(directory, "chats"),
      environmentReady: Promise.resolve(),
      pullRequestExec: async (_command, _args, options) => {
        options.signal?.addEventListener("abort", () => request.reject(options.signal.reason), { once: true });
        started.resolve();
        return request.promise;
      },
    },
    onStopped: stopped.resolve,
  });
  const clients = [];
  let reading;
  try {
    const reader = await connect({ dataDir, timeoutMs: 10000 });
    const control = await connect({ dataDir, timeoutMs: 5000 });
    clients.push(reader, control);
    await reader.call("project:open", [project]);
    reading = reader.call("worktree:pull-request", [project]);
    await started.promise;
    // A mutation accepted while metadata is pending must still survive shutdown.
    await reader.call("chat:patch", [project, 2, { title: "Saved before stopping" }]);
    const accepted = await reader.call("project:read", [project]);
    assert.equal(accepted.state.sessions[2].title, "Saved before stopping", "the title mutation was accepted before shutdown");
    const stopStarted = Date.now();
    const closed = once(control, "close", { signal: AbortSignal.timeout(5000) });
    const [ack] = await Promise.all([control.call("daemon:stop"), closed, stopped.promise]);
    assert.deepEqual(ack, { stopping: true });
    assert.ok(Date.now() - stopStarted < 5000, "acknowledgment, transport close and daemon shutdown finish within 5 s");
    assert.equal(await reading, null);
    await stopped.promise;
    await daemon.close();
    await daemon.close();
    const state = await require("@milagre/core/project-store").readProjectState(project);
    assert.deepEqual(state.messages, messages);
    assert.equal(state.sessions[2].title, "Saved before stopping");
    await assert.rejects(fs.stat(path.join(dataDir, "runtime.lock")), { code: "ENOENT" });
  } finally {
    request.resolve({ stdout: JSON.stringify({ data: { repository: {} } }) });
    await reading?.catch(() => {});
    for (const client of clients) client.close();
    await daemon.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
