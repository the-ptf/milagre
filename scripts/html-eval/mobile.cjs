// Replay immutable generated HTML in the native dev app through an isolated demo host. No provider generation here.
const path = require("node:path"),
  fs = require("node:fs");
const root = path.resolve(__dirname, "../..");
const argv = process.argv.slice(2);
if (!argv.includes("--out")) throw Error("Usage: node scripts/html-eval/mobile.cjs --out DIRECTORY [--port 8897] [--case id,id]");
const out = path.resolve(argv[argv.indexOf("--out") + 1]);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8897);
const filter = argv.includes("--case") ? argv[argv.indexOf("--case") + 1].split(",") : null;
const demoAgent = require(path.join(root, "apps/daemon/src/demo-agent.cjs"));
const original = demoAgent.demoRuntimeOptions;
let current, settled, demo, client, api, metro;
let stopping;
function close() {
  return (stopping ??= (async () => {
    metro?.kill("SIGTERM");
    client?.close();
    await api?.close();
    await demo?.close();
  })());
}
process.once("SIGTERM", () => void close().then(() => process.exit()));
process.once("SIGINT", () => void close().then(() => process.exit()));
demoAgent.demoRuntimeOptions = (args) => {
  const options = original(args),
    create = options.createSession;
  options.createSession = (provider, config) =>
    create(provider, {
      ...config,
      emit(event) {
        if (event.type === "turn-completed" && current) {
          config.emit({ type: "step-started", step: { id: "generated-" + current.id, kind: "artifact", tool: "html_render", title: current.title } });
          config.emit({ type: "step-completed", id: "generated-" + current.id, status: "done", artifact: current });
        }
        config.emit(event);
        if (event.type === "turn-completed") settled?.();
      },
    });
  return options;
};
(async () => {
  const { startDemo } = require(path.join(root, "scripts/mobile-demo.cjs"));
  const { connect } = require(path.join(root, "apps/daemon/src/client.cjs"));
  const { createChatArtifacts } = require(path.join(root, "packages/core/src/chat-artifacts.cjs"));
  const index = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
  const seen = new Set();
  const cases = index.sessions
    .filter((s) => {
      const id = s.caseId || s.sessionId.replace(/-r[0-9]+$/, "");
      if (!s.final || seen.has(id) || (filter && !filter.includes(id))) return false;
      seen.add(id);
      return true;
    })
    .map((s) => ({ title: s.final.title, height: s.final.height, htmlFile: s.final.htmlFile, prompt: s.prompt }));
  if (!cases.length) throw Error("No final HTMLs selected");
  demo = await startDemo({ port });
  client = await connect({ dataDir: demo.dataDir });
  const opened = await client.call("project:open", [demo.project]);
  const chat = Object.values(opened.state.sessions)[0];
  const chatId = demo.project + "#" + chat.id;
  await client.call("chat:patch", [demo.project, chat.id, { title: "Eval HTML: baseline" }]);
  api = createChatArtifacts({ directory: path.join(demo.dataDir, "artifacts"), validateChat: async () => {} });
  for (const item of cases) {
    current = await api.render({
      chatId,
      title: item.title,
      height: Math.max(24, Math.min(2000, item.height || 400)),
      html: fs.readFileSync(item.htmlFile, "utf8"),
    });
    const done = new Promise((r) => (settled = r));
    await client.call("chat:send", [
      { projectPath: demo.project, sessionId: chat.id, body: item.prompt, provider: "codex", model: "demo", permissionMode: "ask" },
    ]);
    await done;
  }
  fs.writeFileSync(path.join(out, "mobile-state.json"), JSON.stringify({ chatId, project: demo.project, sessionId: chat.id, dataDir: demo.dataDir }), {
    mode: 0o600,
  });
  metro = require(path.join(root, "scripts/start-mobile.cjs")).startMetro({
    ...process.env,
    EXPO_PUBLIC_DAEMON_URL: demo.url,
    EXPO_PUBLIC_DAEMON_TOKEN: demo.token,
    EXPO_PUBLIC_DEMO: "1",
  });
  console.log(cases.length + " original model outputs ready in native Chat. Metro on8790; state saved in output directory");
  metro.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    void close();
  });
  metro.once("exit", (code) => {
    if (!stopping) {
      process.exitCode = code || 0;
      void close();
    }
  });
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  void close();
});
