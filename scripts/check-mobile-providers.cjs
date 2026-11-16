const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startMobileHost } = require("./mobile-host.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--run") {
    console.log(
      "Run node scripts/check-mobile-providers.cjs --run to send one short no-tool prompt through each installed Codex, Claude and Antigravity account, then verify saved provider IDs after host restart. This uses provider quota.",
    );
    return;
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-provider-check-")));
  const project = path.join(root, "Project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const options = { dataDir: path.join(root, "profile"), project, port: 0, runtimeOptions: { titleModels: {}, worktreeRoot: path.join(root, "worktrees") } };
  let host;
  try {
    const { createClient } = await import("../apps/mobile/src/client.ts");
    host = await startMobileHost(options);
    const details = JSON.parse(await fs.readFile(host.connectionFile, "utf8"));
    const client = createClient({ address: details.url, token: details.token });
    const opened = await client.call("project:open", [project]);
    const worktreeId = Number(Object.keys(opened.state.worktrees)[0]);
    const saved = [];
    for (const [provider, model] of [
      ["codex", "gpt-6.1-sol"],
      ["claude", "claude-fable-5-1"],
      ["antigravity", "gemini-3.8-flash"],
    ]) {
      const { sessionId } = await client.call("chat:send", [
        {
          projectPath: project,
          worktreeId,
          sessionId: null,
          provider,
          model,
          effort: "low",
          permissionMode: "ask",
          body: "This is a Milagre mobile transport smoke test. Reply with exactly MILAGRE_MOBILE_OK. Do not use tools or modify files.",
        },
      ]);
      const deadline = Date.now() + 180000;
      let message, snapshot;
      while (Date.now() < deadline) {
        snapshot = await client.snapshot(project);
        message = (await client.chatMessages(project, sessionId)).messages.findLast((m) => m.role === "assistant");
        const run = snapshot.runs.runs[`${project}#${sessionId}`];
        if (message && !run) break;
        if (run?.approvals?.length || run?.questions?.length) throw new Error(`${provider}: unexpected approval/question in no-tool smoke test`);
        await delay(1000);
      }
      assert.equal(message?.outcome, "completed", `${provider}: turn did not complete`);
      assert.ok(message.body?.includes("MILAGRE_MOBILE_OK"), `${provider}: expected reply missing`);
      saved.push({ sessionId, chat: snapshot.project.state.sessions[sessionId], message });
      console.log(`PASS ${provider}: real reply through mobile HTTP/socket/core`);
    }
    await host.close();
    host = await startMobileHost(options);
    const next = JSON.parse(await fs.readFile(host.connectionFile, "utf8"));
    assert.equal(next.token, details.token);
    const reconnected = createClient({ address: next.url, token: next.token });
    const reopened = await reconnected.snapshot(project);
    for (const entry of saved) {
      assert.deepEqual(reopened.project.state.sessions[entry.sessionId], entry.chat);
      assert.deepEqual(
        (await reconnected.chatMessages(project, entry.sessionId)).messages.find((m) => m.id === entry.message.id),
        entry.message,
      );
    }
    console.log("PASS restart: private token, Chats, provider session IDs and replies preserved");
  } finally {
    await host?.close();
    console.log(`Saved check Project: ${project}`);
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
