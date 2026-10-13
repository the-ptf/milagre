// An isolated phone review with a real design document and Chat feedback. No provider account is used.
// Run: node scripts/mobile-design-fixture.cjs. Defaults to bridge 8794 and Metro 8894.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { startDaemon } = require("../apps/daemon/src/server.cjs");
const { startMobileBridge } = require("../apps/daemon/src/mobile-bridge.cjs");
const { connect } = require("../apps/daemon/src/client.cjs");
const { demoRuntimeOptions } = require("../apps/daemon/src/demo-agent.cjs");
const { runTool } = require("../packages/core/src/linked-tools.cjs");
const { applyDesignOperations, createDesignInstance, createExampleDesign } = require("../packages/shared/src/design.mjs");
const { startMetro } = require("./start-mobile.cjs");

function createReviewDesign() {
  const document = {
    ...createExampleDesign(),
    nodes: [
      { id: "page", type: "frame", x: 24, y: 32, width: 342, height: 1, heightMode: "hug", layout: "vertical", gap: 18 },
      {
        id: "brand",
        parentId: "page",
        type: "text",
        width: 1,
        height: 1,
        widthMode: "fill",
        heightMode: "hug",
        text: "FIELDNOTES",
        fontSize: 12,
        fontWeight: 700,
        fill: "$muted",
      },
      {
        id: "heading",
        parentId: "page",
        type: "text",
        width: 1,
        height: 1,
        widthMode: "fill",
        heightMode: "hug",
        text: "Make room\nfor a good day.",
        fontFamily: "Georgia, serif",
        fontSize: 34,
        lineHeight: 1.1,
        fill: "$ink",
      },
      {
        id: "today",
        parentId: "page",
        type: "text",
        width: 1,
        height: 1,
        widthMode: "fill",
        heightMode: "hug",
        text: "TODAY",
        fontSize: 12,
        fontWeight: 700,
        fill: "$muted",
      },
      {
        id: "practice",
        parentId: "page",
        name: "Daily practice",
        type: "frame",
        component: true,
        width: 342,
        height: 1,
        widthMode: "fill",
        heightMode: "hug",
        minWidth: 280,
        layout: "vertical",
        padding: 20,
        gap: 10,
        fill: "#ffffff",
        radius: 18,
        stroke: "$line",
        strokeWidth: 1,
      },
      {
        id: "practice-title",
        parentId: "practice",
        type: "text",
        width: 1,
        height: 1,
        widthMode: "fill",
        heightMode: "hug",
        text: "A little less rush.",
        fontFamily: "Georgia, serif",
        fontSize: 23,
        fill: "$ink",
      },
      {
        id: "practice-body",
        parentId: "practice",
        type: "text",
        width: 1,
        height: 1,
        widthMode: "fill",
        heightMode: "hug",
        text: "Take a short walk. Leave your phone in your pocket. Notice what changed.",
        fontSize: 14,
        lineHeight: 1.4,
        fill: "$muted",
      },
      {
        id: "practice-button",
        parentId: "practice",
        type: "frame",
        width: 1,
        height: 42,
        widthMode: "fill",
        minHeight: 42,
        layout: "horizontal",
        padding: 10,
        align: "center",
        justify: "center",
        fill: "$accent",
        radius: 10,
      },
      {
        id: "practice-action",
        parentId: "practice-button",
        type: "text",
        width: 1,
        height: 1,
        widthMode: "hug",
        heightMode: "hug",
        text: "Start a 10-minute walk",
        fontSize: 14,
        fontWeight: 700,
        fill: "#ffffff",
      },
      {
        id: "tomorrow",
        parentId: "page",
        type: "text",
        width: 1,
        height: 1,
        widthMode: "fill",
        heightMode: "hug",
        text: "TOMORROW",
        fontSize: 12,
        fontWeight: 700,
        fill: "$muted",
      },
    ],
  };
  return applyDesignOperations(document, [
    ...createDesignInstance(document, "practice", "tomorrow-practice", { parentId: "page" }),
    {
      op: "insert",
      node: {
        id: "footer",
        parentId: "page",
        type: "text",
        width: 1,
        height: 1,
        widthMode: "fill",
        heightMode: "hug",
        text: "Small steps. A day at a time.",
        fontSize: 12,
        textAlign: "center",
        fill: "$muted",
      },
    },
  ]);
}

async function startFixture({ port = 8794, metroPort = 8894, root: resumeRoot } = {}) {
  const root = await fs.realpath(resumeRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), "milagre-mobile-design-"))));
  if (!path.basename(root).startsWith("milagre-mobile-design-")) throw new Error("Resume only a task-owned mobile design fixture.");
  const project = path.join(root, "Design playground");
  const dataDir = path.join(root, "profile");
  await fs.mkdir(project, { recursive: true });
  if (!resumeRoot) execFileSync("git", ["init", "-qb", "main", project]);
  let shown;
  const runtimeOptions = {
    ...demoRuntimeOptions({ cwd: project, worktreeRoot: path.join(root, "worktrees") }),
    createSession(_provider, options) {
      return {
        turnActive: false,
        async startTurn() {
          this.turnActive = true;
          options.emit({ type: "turn-started", turnId: "design-preview" });
          if (!shown && resumeRoot) {
            const read = options.linked.tools.find((entry) => entry.name === "design_read");
            if (!read) throw new Error("The design_read tool was not installed in the fixture.");
            const stored = await runTool(read, { id: "fieldnotes" });
            if (stored.isError) throw new Error(stored.text);
            const value = JSON.parse(stored.text);
            shown = { id: value.id, title: value.title, version: value.version, format: "design" };
          }
          if (!shown) {
            const tool = options.linked.tools.find((entry) => entry.name === "design_show");
            if (!tool) throw new Error("The design_show tool was not installed in the fixture.");
            const first = await runTool(tool, { id: "fieldnotes", title: "Fieldnotes", document: createReviewDesign() });
            if (first.isError) throw new Error(first.text);
            const edit = options.linked.tools.find((entry) => entry.name === "design_apply");
            if (!edit) throw new Error("The design_apply tool was not installed in the fixture.");
            const result = await runTool(edit, {
              id: "fieldnotes",
              expectedVersion: JSON.parse(first.text.split("\n", 1)[0]).version,
              operations: [{ op: "update", id: "practice-title", patch: { text: "A little more outside." } }],
            });
            if (result.isError) throw new Error(result.text);
            // The summary is the first line; the rest is notes for the agent.
            const { warnings: _warnings, warningCount: _count, ...summary } = JSON.parse(result.text.split("\n", 1)[0]);
            shown = summary;
          }
          options.emit({ type: "step-started", step: { id: "design-preview", kind: "artifact", title: "Created Fieldnotes", artifact: shown } });
          options.emit({ type: "step-completed", id: "design-preview", status: "done", artifact: shown });
          options.emit({
            type: "text-delta",
            text: "Open Fieldnotes to review the design. Choose it or leave a comment, then Send to request changes in Chat.",
          });
          this.turnActive = false;
          options.emit({ type: "turn-completed" });
          return { turnId: "design-preview" };
        },
        async interrupt() {
          this.turnActive = false;
          options.emit({ type: "turn-cancelled" });
        },
        async close() {
          this.turnActive = false;
        },
      };
    },
  };
  const daemon = await startDaemon({ dataDir, runtimeOptions });
  const client = await connect({ dataDir });
  const opened = await client.call("project:open", [project]);
  const chat = Object.values(opened.state.sessions)[0];
  await client.call("chat:patch", [project, chat.id, { title: "Review designs" }]);
  if (!resumeRoot)
    await client.call("chat:send", [
      { projectPath: project, sessionId: chat.id, body: "Create an editable Fieldnotes screen.", provider: "codex", model: "demo" },
    ]);
  const token = randomBytes(32).toString("hex");
  const bridge = await startMobileBridge({ dataDir, port, token });
  const details = { root, project, dataDir, chatId: `${project}#${chat.id}`, url: bridge.url, token, metroPort, pid: process.pid };
  await fs.writeFile(path.join(root, "connection.json"), JSON.stringify(details), { mode: 0o600 });
  const metroEnvironment = { ...process.env, EXPO_PUBLIC_DAEMON_URL: bridge.url, EXPO_PUBLIC_DAEMON_TOKEN: token, EXPO_PUBLIC_DEMO: "1" };
  delete metroEnvironment.CI;
  const metro = startMetro(metroEnvironment, ["--port", String(metroPort), "--max-workers", "2"]);
  console.log(`Design fixture ready. Metro: ${metroPort}. Bridge: ${port}.\nConnection file: ${path.join(root, "connection.json")}`);
  let closing;
  const close = () =>
    (closing ??= (async () => {
      metro.kill("SIGTERM");
      await bridge.close();
      client.close();
      await daemon.close();
    })());
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  metro.once("exit", () => void close());
  return { ...details, close };
}

if (require.main === module)
  startFixture({
    port: Number(process.env.MILAGRE_MOBILE_PORT || 8794),
    metroPort: Number(process.env.MILAGRE_METRO_PORT || 8894),
    root: process.env.MILAGRE_DESIGN_FIXTURE_ROOT,
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { startFixture, createReviewDesign };
