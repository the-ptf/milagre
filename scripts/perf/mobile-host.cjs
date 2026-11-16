const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { spawn, execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { startDaemon } = require("../../apps/daemon/src/server.cjs");
const { startMobileBridge } = require("../../apps/daemon/src/mobile-bridge.cjs");
const { connect } = require("../../apps/daemon/src/client.cjs");
const { demoRuntimeOptions } = require("../../apps/daemon/src/demo-agent.cjs");
const { pairingLink } = require("../../apps/daemon/src/mobile-pairing.cjs");

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8961" },
    metro: { type: "string", default: "8912" },
    chats: { type: "string", default: "0" },
    seconds: { type: "string", default: "60" },
    "no-metro": { type: "boolean", default: false },
    root: { type: "string" },
  },
});
const SECONDS = Number(values.seconds);

function section(n) {
  return [
    `## Section ${n}\n\nParagraph ${n} is ordinary prose, long enough to wrap on a phone, with \`inline code\` and a [link](https://example.com).\n`,
    `- First item of list ${n}\n- Second item, a little longer than the first one\n- Third item\n`,
    "```ts",
    `export function step${n}(rows: Row[]): number {`,
    "  return rows.filter((row) => row.changed).length;",
    "}",
    "```\n\n",
  ].join("\n");
}

function perfSession(_provider, { emit }) {
  const timers = new Set();
  const later = (ms, run) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };
  const session = {
    closed: false,
    turnActive: false,
    nativeId: "milagre-perf",
    async startTurn({ prompt }) {
      const turnId = `perf-${Date.now()}`;
      session.turnActive = true;
      emit({ type: "session-started", nativeId: session.nativeId });
      emit({ type: "turn-started", turnId });
      const finish = (text) => {
        emit({ type: "text-delta", text });
        session.turnActive = false;
        emit({ type: "turn-completed" });
      };
      if (/perf-tool/i.test(prompt)) {
        emit({ type: "text-delta", text: "Running the build.\n\n" });
        emit({ type: "step-started", step: { id: `${turnId}-bash`, kind: "shell", title: "Run `npm run build`", detail: "$ npm run build" } });
        later(SECONDS * 1000, () => {
          emit({ type: "step-completed", id: `${turnId}-bash`, status: "done", note: "built" });
          finish("The build finished.");
        });
      } else if (/perf-steps/i.test(prompt)) {
        let n = 0;
        const next = () => {
          if (n > 0) emit({ type: "step-completed", id: `${turnId}-${n}`, status: "done", note: "ok" });
          if (n * 2 >= SECONDS) return finish("All steps done.");
          n++;
          emit({ type: "step-started", step: { id: `${turnId}-${n}`, kind: "read", title: `Read \`file-${n}.ts\``, detail: "" } });
          later(2000, next);
        };
        next();
      } else if (/perf-stream/i.test(prompt)) {
        let text = "";
        for (let n = 1; text.length < SECONDS * 20 * 16; n++) text += section(n);
        let at = 0;
        const tick = () => {
          if (at >= text.length) return finish("\n\nDone.");
          emit({ type: "text-delta", text: text.slice(at, at + 16) });
          at += 16;
          later(50, tick);
        };
        tick();
      } else {
        later(300, () => finish("Perf host. Send perf-stream, perf-tool or perf-steps."));
      }
      return { turnId };
    },
    respondToPermission: () => false,
    answerQuestion: () => false,
    async interrupt() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      if (session.turnActive) emit({ type: "turn-cancelled" });
      session.turnActive = false;
    },
    async close() {
      await session.interrupt();
      session.closed = true;
    },
  };
  return session;
}

async function main() {
  const reuse = Boolean(values.root);
  const root = reuse ? await fs.realpath(values.root) : await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-mobile-perf-")));
  const dataDir = path.join(root, "profile");
  const project = path.join(root, "Perf");
  if (!reuse) {
    await fs.mkdir(project);
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    await fs.writeFile(path.join(project, ".gitignore"), ".milagre/\n");
    execFileSync("git", ["-C", project, "add", "."]);
    execFileSync("git", ["-C", project, "-c", "user.name=Perf", "-c", "user.email=perf@example.invalid", "commit", "-q", "-m", "init"]);
  }
  const daemon = await startDaemon({
    dataDir,
    version: "0.1.0-perf",
    runtimeOptions: { ...demoRuntimeOptions({ cwd: project, worktreeRoot: path.join(root, "worktrees") }), createSession: perfSession },
  });
  const client = await connect({ dataDir });
  const opened = await client.call("project:open", [project]);
  const first = Object.values(opened.state.sessions)[0];
  await client.call("chat:patch", [project, first.id, { title: "Perf run" }]);
  const worktreeId = first.worktree_id ?? first.worktreeId;
  const send = (body, sessionId) =>
    client.call("chat:send", [
      { projectPath: project, worktreeId, ...(sessionId ? { sessionId } : {}), body, provider: "codex", model: "demo", permissionMode: "ask" },
    ]);
  const extra = [];
  for (let n = 1; n <= Number(values.chats); n++) extra.push(await send("perf-stream").catch((error) => console.warn(`Extra Chat ${n}: ${error.message}`)));
  const tokenFile = path.join(root, "token");
  const token = reuse ? (await fs.readFile(tokenFile, "utf8")).trim() : randomBytes(32).toString("hex");
  if (!reuse) await fs.writeFile(tokenFile, token, { mode: 0o600 });
  const bridge = await startMobileBridge({ dataDir, port: Number(values.port), token });
  // The link carries the token: written to a private file, never printed. Open it with `xcrun simctl openurl <udid> "$(cat <root>/pair.txt)"`.
  await fs.writeFile(path.join(root, "pair.txt"), pairingLink({ address: bridge.url, token, name: "Perf host" }), { mode: 0o600 });
  console.log(JSON.stringify({ bridge: bridge.url, root, project, firstChat: first.id, extraChats: extra.filter(Boolean).length, worktreeId }));
  const metro = values["no-metro"]
    ? null
    : spawn(
        process.execPath,
        [
          "--dns-result-order=ipv4first",
          path.join(path.dirname(require.resolve("expo/package.json", { paths: [path.resolve(__dirname, "../../apps/mobile")] })), "bin/cli"),
          "start",
          "--localhost",
          "--port",
          values.metro,
        ],
        {
          cwd: path.resolve(__dirname, "../../apps/mobile"),
          stdio: "inherit",
          env: { ...process.env, EXPO_PUBLIC_DAEMON_URL: bridge.url, EXPO_PUBLIC_DAEMON_TOKEN: token, CI: "1" },
        },
      );
  const stop = async () => {
    metro?.kill("SIGTERM");
    await bridge.close();
    client.close();
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
