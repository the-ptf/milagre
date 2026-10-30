// Real Codex + production daemon/MCP/artifact storage in a disposable Project/profile.
// No credential files are read or copied here. Codex uses its existing sign-in, with ephemeral threads.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { createHash } = require("node:crypto");
const { startDaemon } = require("../apps/daemon/src/server.cjs");
const { connect } = require("../apps/daemon/src/client.cjs");
const { CodexSession } = require("../packages/core/src/agents/codex-provider.cjs");
const { CodexRpc } = require("../packages/core/src/agents/codex-rpc.cjs");
const { createLinkedMcpServer } = require("../packages/core/src/linked-mcp-server.cjs");

const DESIGN_TOOLS = new Set(["design_show", "design_read", "design_apply", "design_export"]);
const READ_DESIGN_SKILL = `cat ${path.resolve(__dirname, "../packages/core/src/bundled-skills/design/SKILL.md")}`;
const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const milliseconds = (start) => Math.round((performance.now() - start) * 10) / 10;

function fixturePermission(event, turn, allowedSkillReads = []) {
  if (event.kind === "command") {
    if (event.command === READ_DESIGN_SKILL) return true;
    const file = /^cat (\/[a-zA-Z0-9_./-]+)$/.exec(event.command)?.[1];
    return Boolean(file && allowedSkillReads.some((allowed) => path.resolve(file) === allowed));
  }
  if (event.tool !== "MCP: milagre") return false;
  const name = /^Allow the milagre MCP server to run tool "([a-z_]+)"\?$/.exec(event.title)?.[1];
  const allowed = turn.label === "create" ? ["design_show"] : ["design_read", "design_apply"];
  if (!allowed.includes(name)) return false;
  try {
    const args = JSON.parse(event.detail);
    return args.id === "daily-notes";
  } catch {
    return false;
  }
}

async function providerSettings({ command = "codex", model, effort, allowedSkillReads = [] } = {}) {
  const designSkillSha256 = createHash("sha256")
    .update(await fs.readFile(READ_DESIGN_SKILL.slice(4)))
    .digest("hex");
  const approvedReads = [];
  for (const file of allowedSkillReads) {
    const absolute = await fs.realpath(file);
    const roots = [".codex/skills", ".agents/skills", ".codex/plugins/cache"].map((root) => path.join(os.homedir(), root));
    if (!absolute.endsWith(".md") || !roots.some((root) => absolute.startsWith(root + path.sep)))
      throw new Error("Extra reads must name an installed skill Markdown file.");
    approvedReads.push(absolute);
  }
  const rpc = new CodexRpc({ command, cwd: os.tmpdir() });
  rpc.start();
  try {
    await rpc.request("initialize", { clientInfo: { name: "milagre-design-check", version: "1" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized");
    const auth = await rpc.request("account/read", { refreshToken: false });
    if (auth.requiresOpenaiAuth && !auth.account) throw new Error("Codex is not signed in. This check will not start authentication.");
    const available = (await rpc.request("model/list", { includeHidden: false })).data ?? [];
    const selected = model ? available.find((entry) => entry.model === model || entry.id === model) : available.find((entry) => entry.isDefault);
    if (!selected) throw new Error("The requested Codex model is not in the provider's model list.");
    const chosenEffort = effort ?? selected.defaultReasoningEffort ?? "low";
    if (!selected.supportedReasoningEfforts?.some((entry) => entry.reasoningEffort === chosenEffort))
      throw new Error("The model does not support this effort.");
    return {
      command,
      model: selected.model ?? selected.id,
      effort: chosenEffort,
      fastMode: false,
      designSkillSha256,
      allowedSkillReads: approvedReads,
      cliVersion: execFileSync(command, ["--version"], { encoding: "utf8" }).trim(),
    };
  } finally {
    await rpc.close();
  }
}

async function startHarness(settings) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-design-live-")));
  const project = path.join(root, "Project");
  const dataDir = path.join(root, "profile");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-qb", "main", project]);
  await fs.writeFile(path.join(project, "README.md"), "# Design test Project\n\nDisposable live-provider verification.\n");
  const sessions = [];
  const toolsBySession = new Map();
  const mcp = createLinkedMcpServer({ toolsFor: (id) => toolsBySession.get(id) ?? [] });
  let activeTurn = null;
  let lastUsage = null;
  let daemon;
  let client;
  const runtimeOptions = {
    cwd: project,
    worktreeRoot: path.join(root, "worktrees"),
    environmentReady: Promise.resolve(),
    titleModels: {},
    readUsage: async () => ({ providers: [] }),
    expandSkills: false,
    agentCli: Object.assign(async (provider) => ({ command: provider === "codex" ? settings.command : null, env: process.env }), { invalidate() {} }),
    agentModels: async () => ({ codex: [{ id: settings.model, name: settings.model, efforts: [] }], claude: null, antigravity: null, kiro: null }),
    readPullRequest: async () => null,
    readPullRequests: async () => [],
    observeAgentEvent(chatId, event) {
      const turn = activeTurn;
      if (!turn || turn.chatId !== chatId) return;
      if (event.type === "step-started") turn.steps.push({ id: event.step.id, kind: event.step.kind, title: event.step.title });
      if (event.type === "step-completed" && event.artifact) turn.cards.push(event.artifact);
      if (event.type === "text-delta") turn.assistantText += event.text;
      if (event.type === "permission-request" || event.type === "question-request") {
        if (event.type === "permission-request" && fixturePermission(event, turn, settings.allowedSkillReads)) {
          // Only the bundled skill read and fixture-owned artifact calls, one call at a time.
          void client.call("agent:respond-permission", [{ chatId, requestId: event.requestId, decision: "allow" }]).catch(turn.reject);
          return;
        }
        turn.reject(
          new Error(
            `The live check stopped on ${event.type}: ${event.title ?? event.tool ?? ""}${event.command ? ` (${event.command})` : ""}. No approval or answer was supplied automatically.`,
          ),
        );
      }
      if (["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type)) {
        turn.status = event.type;
        turn.durationMs = milliseconds(turn.started);
        if (event.type === "turn-completed") turn.resolve();
        else turn.reject(new Error(event.message ?? event.type));
      }
    },
    createSession(provider, options) {
      if (provider !== "codex") throw new Error("This opt-in check only runs Codex.");
      const sessionKey = String(sessions.length + 1);
      const tools = options.linked.tools
        .filter((tool) => DESIGN_TOOLS.has(tool.name))
        .map((tool) => ({
          ...tool,
          async run(args) {
            const trace = { name: tool.name, inputBytes: bytes(args), arguments: args, outputBytes: 0, durationMs: 0 };
            const turn = activeTurn;
            turn?.tools.push(trace);
            const started = performance.now();
            try {
              const result = await tool.run(args);
              trace.outputBytes = bytes(result);
              trace.result = JSON.parse(typeof result === "string" ? result : result.text.split("\n", 1)[0]);
              return result;
            } catch (error) {
              trace.error = error.message;
              throw error;
            } finally {
              trace.durationMs = milliseconds(started);
            }
          },
        }));
      toolsBySession.set(sessionKey, tools);
      const session = new CodexSession({
        ...options,
        clientVersion: "design-live-check",
        linked: {
          tools,
          url: () => mcp.url(sessionKey),
          toolsAvailable: (available) => {
            if (!available && activeTurn) activeTurn.toolsUnavailable = true;
          },
        },
        createRpc(rpcOptions) {
          const rpc = new CodexRpc(rpcOptions);
          const request = rpc.request.bind(rpc);
          rpc.request = async (method, params, options) => {
            if (method === "thread/start") {
              // Per-thread overrides only: external MCPs stay disabled, and no provider conversation is saved.
              const inherited = (await request("config/read", { cwd: project })).config;
              const disabled = Object.fromEntries(Object.keys(inherited.mcp_servers ?? {}).map((name) => [name, { enabled: false }]));
              params = { ...params, ephemeral: true, config: { ...params.config, mcp_servers: { ...disabled, ...params.config?.mcp_servers } } };
            }
            return request(method, params, options);
          };
          rpc.on("notification", ({ method, params }) => {
            if (method === "thread/tokenUsage/updated") {
              lastUsage = params.tokenUsage;
              if (activeTurn) activeTurn.usage = params.tokenUsage;
            }
            if (activeTurn && method === "item/completed" && /tool/i.test(params.item?.type ?? "")) {
              const item = params.item;
              activeTurn.providerTools.push({
                type: item.type,
                server: item.server,
                tool: item.tool,
                status: item.status,
                success: item.success,
                error: item.error,
                ...(item.status === "failed"
                  ? {
                      errorText: item.result?.content
                        ?.filter((block) => block.type === "text")
                        .map((block) => block.text)
                        .join("\n")
                        .slice(0, 4000),
                    }
                  : {}),
              });
            }
          });
          rpc.on("request", ({ method, params }) => {
            if (activeTurn) activeTurn.providerRequests.push({ method, tool: params.toolName ?? params.tool, server: params.serverName ?? params.server });
          });
          return rpc;
        },
      });
      sessions.push(session);
      return session;
    },
  };
  const close = async () => {
    if (activeTurn) await Promise.all(sessions.map((session) => session.interrupt().catch(() => {})));
    client?.close();
    await daemon?.close();
    await mcp.close();
    await fs.rm(project, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(path.join(root, "worktrees"), { recursive: true, force: true });
  };
  try {
    daemon = await startDaemon({ dataDir, version: "design-live-check", runtimeOptions });
    client = await connect({ dataDir });
    const opened = await client.call("project:open", [project]);
    const sessionId = Object.values(opened.state.sessions)[0].id;
    const chatId = `${project}#${sessionId}`;
    return {
      root,
      project,
      dataDir,
      chatId,
      client,
      close,
      async turn(label, prompt, timeoutMs = 300000) {
        if (activeTurn) throw new Error("Run live samples sequentially.");
        let timer;
        const turn = {
          label,
          chatId,
          prompt,
          started: performance.now(),
          usageBefore: lastUsage?.total,
          tools: [],
          steps: [],
          cards: [],
          assistantText: "",
          providerTools: [],
          providerRequests: [],
        };
        const done = new Promise((resolve, reject) => {
          turn.resolve = resolve;
          turn.reject = reject;
          timer = setTimeout(() => reject(new Error(`The ${label} turn exceeded ${timeoutMs / 1000} seconds.`)), timeoutMs);
        });
        // Observe the rejection even if chat:send is still starting its provider.
        done.catch(() => {});
        activeTurn = turn;
        try {
          await client.call("chat:send", [
            {
              projectPath: project,
              sessionId,
              body: prompt,
              provider: "codex",
              model: settings.model,
              effort: settings.effort,
              fastMode: false,
              permissionMode: "ask",
            },
          ]);
          await done;
          if (turn.toolsUnavailable) throw new Error("Codex fell back without the design MCP tools.");
          return turn;
        } catch (error) {
          error.turn = summarizedTurn(turn);
          throw error;
        } finally {
          clearTimeout(timer);
          if (!turn.status) await Promise.all(sessions.map((session) => session.interrupt().catch(() => {})));
          activeTurn = null;
        }
      },
      artifact: (id, version) => client.call("artifact:get", [{ chatId, id, ...(version === undefined ? {} : { version }) }]),
      edit: (id, expectedVersion, operations) => client.call("artifact:apply", [{ chatId, id, expectedVersion, operations }]),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function summarizedTurn(turn) {
  const usage = turn.usage?.total;
  const tokenUsageDelta = usage
    ? Object.fromEntries(
        Object.entries(usage)
          .filter(([, value]) => typeof value === "number")
          .map(([name, value]) => [name, value - (turn.usageBefore?.[name] ?? 0)]),
      )
    : null;
  return {
    label: turn.label,
    prompt: turn.prompt,
    durationMs: turn.durationMs,
    status: turn.status,
    usage: turn.usage,
    tokenUsageDelta,
    cards: turn.cards,
    assistantText: turn.assistantText,
    providerTools: turn.providerTools,
    providerRequests: turn.providerRequests,
    tools: turn.tools.map(({ name, inputBytes, outputBytes, durationMs, arguments: args, error }) => ({
      name,
      inputBytes,
      outputBytes,
      durationMs,
      ...(args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion }),
      ...(error ? { error } : {}),
    })),
    otherSteps: turn.steps.filter((step) => step.kind !== "artifact"),
  };
}

module.exports = { providerSettings, startHarness, summarizedTurn, bytes, fixturePermission };
