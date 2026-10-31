const { isDeepStrictEqual } = require("node:util");
const { readMcpExtras } = require("../mcp/extras.cjs");
const { active: activeSubagent, settleSubagents } = require("./subagents.cjs");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { decodeImages } = require("../image-input.cjs");
const { mkdirSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexRpc } = require("./codex-rpc.cjs");
const { toCodexConfig } = require("../mcp/definitions.cjs");
const { CODEX_FAST_TIER } = require("./models.cjs");
const { advisorPolicy, advisorCodexConfig } = require("./advisor-policy.cjs");
const {
  sessionInstructions,
  RESUME_FAILED_MESSAGE,
  crashMessage,
  failedWith,
  isTerminal,
  loginMessage,
  mapCodexNotification,
  missingCliMessage,
} = require("./events.cjs");
const {
  PendingPermissions,
  codexCommandRequest,
  codexDecision,
  codexFileRequest,
  codexMcpRequest,
  codexMcpResponse,
  isCodexPlanToolApproval,
  WorkspaceAccess,
} = require("./permissions.cjs");
const { PendingQuestions, codexQuestionRequest, codexQuestionResponse } = require("./questions.cjs");
const { babysitDenial } = require("../babysit-guard.cjs");
const { promptImageBlocks } = require("@milagre/shared/prompt-parts");

// Outside Plan mode, Codex offers its question tool (request_user_input) only behind this feature.
// It is set per thread, where an unknown feature is ignored; `--enable` would refuse to start instead.
const THREAD_CONFIG = { features: { default_mode_request_user_input: true } };

// Milagre permission mode -> Codex policy. Ask asks before any command Codex doesn't already trust,
// Auto only when Codex wants to go beyond the workspace sandbox, and Full never asks. Bot rules asks
// like Ask, so every untrusted command reaches the bot's policy (under on-request a sandboxed
// `gh pr merge` would run unasked), with network on because a bot's work needs it.
// A babysit Run's turn (`guarded`) must show Milagre every command its level might refuse. Full keeps its sandbox but
// asks about untrusted commands, which Milagre then allows itself (PendingPermissions); Ask already asks, and Auto's
// sandbox has no network, so a push or a GitHub write can only run once Codex asks to leave it.
function codexPolicy(permissionMode, cwd, workspaceRoots = [], { guarded = false } = {}) {
  if (permissionMode === "full")
    return { approvalPolicy: guarded ? "untrusted" : "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  return {
    approvalPolicy: permissionMode === "auto" ? "on-request" : "untrusted",
    sandbox: "workspace-write",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [...new Set([cwd, ...workspaceRoots])],
      networkAccess: permissionMode === "bot",
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}

async function writeImages(images) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-images-"));
  const paths = [];
  for (const [index, image] of images.entries()) {
    const file = path.join(directory, `${index}.${image.mime.split("/")[1]}`);
    await fs.writeFile(file, image.bytes, { mode: 0o600 });
    paths.push(file);
  }
  return { paths, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

// A generated image Codex didn't save is only base64 in the item; it is written out so the chat can show it.
function saveGeneratedImage(item, directory = path.join(os.tmpdir(), "milagre-generated-images")) {
  if (item?.type !== "imageGeneration" || item.savedPath || typeof item.result !== "string" || !item.result) return item;
  try {
    const file = path.join(directory, `${String(item.id).replace(/[^\w.-]/g, "_")}.png`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, Buffer.from(item.result, "base64"));
    return { ...item, savedPath: file };
  } catch {
    return item;
  }
}

// Tool image blocks are separate visible steps; their base64 never bloats the saved transcript. Milagre's design
// renders and HTML previews are for the agent to inspect, not separate images to publish in the conversation.
// Codex preserves this MCP provenance for nested calls from functions.exec too (their IDs start with "exec-").
const isInternalRender = (item) =>
  item?.type === "mcpToolCall" && item.server === "milagre" && ["design_show", "design_apply", "html_preview"].includes(item.tool);
function toolImageEvents(item) {
  if (isInternalRender(item)) return [];
  if (!["mcpToolCall", "dynamicToolCall"].includes(item?.type) || item.status !== "completed" || item.success === false || item.error) return [];
  const content = item.type === "mcpToolCall" ? item.result?.content : item.contentItems;
  if (!Array.isArray(content)) return [];
  const events = [];
  for (const [index, block] of content.entries()) {
    if (!["image", "inputImage"].includes(block?.type)) continue;
    try {
      const dataUrl = block.data ? `data:${block.mimeType};base64,${block.data}` : block.imageUrl || block.image_url;
      const [{ bytes, mime }] = decodeImages([{ dataUrl }]);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const directory = path.join(os.tmpdir(), "milagre-generated-images");
      mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${hash}.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`);
      writeFileSync(file, bytes, { mode: 0o600 });
      const id = `${item.id}:image:${index}`;
      events.push({ type: "step-started", step: { id, kind: "image", title: "Image from tool", file } }, { type: "step-completed", id, status: "done", file });
    } catch {
      /* Unsupported tool media must not interrupt its text result. */
    }
  }
  return events;
}

const turnInput = (prompt, files) =>
  promptImageBlocks(prompt, files?.paths ?? []).map((block) =>
    block.type === "text" ? { type: "text", text: block.text, text_elements: [] } : { type: "localImage", path: block.image },
  );

// account/read answers in well under a second; a Codex that doesn't is not held up for the default RPC timeout.
const ACCOUNT_TIMEOUT_MS = 8000;
// thread/start and thread/resume wait for Codex however long it takes (see requestThread).
const THREAD_TIMEOUT_MS = null;

const sessionClosedError = () => Object.assign(new Error("The agent session closed before this message was sent."), { sessionClosed: true });

async function readLatestChildTurn(rpc, threadId) {
  const { thread } = await rpc.request("thread/read", { threadId }, { timeoutMs: 5000 });
  if (thread?.status?.type === "active") return thread;
  try {
    // Outcome recovery needs no transcript or earlier turns.
    const page = await rpc.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, { timeoutMs: 5000 });
    return { ...thread, turns: page.data.slice(0, 1) };
  } catch (error) {
    if (!error.rpcError) throw error;
    // Older providers do not have the paginated endpoint.
    return (await rpc.request("thread/read", { threadId, includeTurns: true }, { timeoutMs: 5000 })).thread;
  }
}

class CodexSession {
  constructor({
    cwd,
    resumeId,
    command,
    env,
    emit,
    workspaceRoots,
    readOnlyRoots,
    // The SessionManager's, which follows a shared Link Chat's Worktrees; a session made alone (an advisor) has its own.
    access = new WorkspaceAccess({ cwd, workspaceRoots, readOnlyRoots }),
    workspaceInstructions,
    tldrEnabled = true,
    sharedLink = false,
    analysisOnly = false,
    executionAdvisor = false,
    linked = null,
    mcpExtras = null,
    clientVersion = "0.0.0",
    interruptGraceMs = 3000,
    // Bot rules only: the bot's answer to each permission request (see PendingPermissions).
    permissionPolicy,
    createRpc = (options) => new CodexRpc(options),
  }) {
    Object.assign(this, {
      cwd,
      resumeId,
      command,
      env,
      emit,
      access,
      workspaceInstructions,
      tldrEnabled,
      sharedLink,
      analysisOnly,
      executionAdvisor,
      linked,
      mcpExtras,
      clientVersion,
      interruptGraceMs,
      permissionPolicy,
      createRpc,
    });
    // steps: ids of the tool steps started in this turn and not yet completed.
    this.state = { threadId: resumeId ?? null, turnId: null, lastItemId: null, hasText: false, steps: new Set() };
    this.rpc = null;
    this.starting = null;
    this.turnActive = false;
    this.cancelRequested = false;
    // Image files written for this turn's messages; removed when the turn ends.
    this.imageSets = [];
    // Settle once the running turn has its id (or failed to start), and once it has ended.
    this.turnReady = Promise.resolve();
    this.turnEnded = Promise.resolve();
    this.ready = false;
    this.closed = false;
    this.permissions = new PendingPermissions((event) => this.emit(event), { policy: permissionPolicy });
    this.questions = new PendingQuestions((event) => this.emit(event));
    // fileChange items by id, from item/started: their approval requests carry no diff of their own.
    this.fileChanges = new Map();
    // A babysit Run's level ({ level, resolveThreads }) while its turn runs, else null; and the commands it refused by
    // item id ({ command, reason }), so their steps say why.
    this.guard = null;
    this.refused = new Map();
  }

  get nativeId() {
    return this.state.threadId;
  }

  /** The app-server process, while it runs; the ports its commands open belong to the chat. */
  get pid() {
    const child = this.rpc?.child;
    return this.closed || child?.exitCode != null || child?.signalCode != null || child?.killed ? null : (child?.pid ?? null);
  }

  async startTurn(request) {
    if (this.turnActive) return this.steer(request);
    if (!this.command) {
      this.emit(failedWith(missingCliMessage("codex")));
      return { turnId: null, steered: false };
    }
    this.turnActive = true;
    this.cancelRequested = false;
    this.guard = request.guard ?? null;
    Object.assign(this.state, { turnId: null, lastItemId: null, hasText: false });
    let markReady;
    this.turnReady = new Promise((resolve) => {
      markReady = resolve;
    });
    this.turnEnded = new Promise((resolve) => {
      this.markTurnEnded = resolve;
    });
    try {
      return await this.beginTurn(request);
    } finally {
      markReady();
    }
  }

  async beginTurn({ prompt, images = [], model, permissionMode, effort, fastMode = false, canStart }) {
    const policy = this.analysisOnly
      ? advisorPolicy("codex", this.linked?.tools ?? [])
      : codexPolicy(permissionMode, this.cwd, this.access.roots, { guarded: Boolean(this.guard) });
    // The turn's sandbox writes to every owned root; one made during the turn reaches it through approvals.
    this.access.learned();
    this.permissions.setMode(permissionMode);
    try {
      this.starting ??= this.start(model, policy);
      await this.starting;
      if (this.cancelRequested) {
        await this.finishTurn([{ type: "turn-cancelled" }]);
        return { turnId: null, steered: false };
      }
      const files = images.length ? await writeImages(images) : null;
      if (files) this.imageSets.push(files);
      if (canStart && !canStart()) {
        await this.finishTurn([]);
        return { turnId: null, steered: false, cancelled: true };
      }
      const { turn } = await this.rpc.request(
        "turn/start",
        {
          threadId: this.state.threadId,
          ...(this.analysisOnly ? { environments: [] } : {}),
          input: turnInput(prompt, files),
          model,
          ...(effort ? { effort } : {}),
          // Codex only sends reasoning summaries when asked; they are the reply's thinking steps.
          summary: "auto",
          // The composer's fast mode toggle decides each turn's speed tier, as it does for Claude; off means
          // standard speed even where ~/.codex/config.toml sets service_tier. Per turn, so the thread keeps none.
          serviceTierForTurn: fastMode ? CODEX_FAST_TIER : "default",
          approvalPolicy: policy.approvalPolicy,
          sandboxPolicy: policy.sandboxPolicy,
        },
        { timeoutMs: 90_000 },
      );
      this.state.turnId ??= turn?.id ?? null;
      if (this.cancelRequested) void this.interrupt();
      return { turnId: this.state.turnId, steered: false };
    } catch (error) {
      if (error.resumeFailed) {
        await this.finishTurn([{ type: "session-reset" }, failedWith(RESUME_FAILED_MESSAGE)]);
        await this.close();
      } else {
        await this.finishTurn([
          this.cancelRequested
            ? { type: "turn-cancelled" }
            : error.notice
              ? failedWith(error.message, { login: error.login === true })
              : { type: "turn-failed", message: error.message },
        ]);
        // A session that never finished starting is unusable; closing it lets the manager start over.
        if (!this.ready) await this.close();
      }
      return { turnId: null, steered: false };
    }
  }

  // A message for the running turn joins it through turn/steer, once the turn has an id. If Codex
  // refuses because the turn already ended, the message starts the next turn instead.
  async steer(request) {
    await this.turnReady;
    const ended = this.turnEnded;
    if (!this.turnActive) return this.startTurn(request);
    // A turn that was asked to stop takes no more messages; this one starts the next turn.
    if (this.cancelRequested) {
      await ended;
      if (this.closed) throw sessionClosedError();
      return this.startTurn(request);
    }
    // Without a turn id Codex can't be steered; send the message as the next turn once this one ends.
    if (!this.state.turnId) {
      await ended;
      if (this.closed) throw sessionClosedError();
      return this.startTurn(request);
    }
    if (request.permissionMode) this.setPermissionMode(request.permissionMode);
    // A message steered into a babysit Run doesn't lift its guard. A babysit Run itself never steers into a running turn:
    // its delivery waits while the Chat is busy, so it always starts a turn of its own with the guarded policy.
    if (request.guard) this.guard = request.guard;
    const turnId = this.state.turnId;
    // An open question waits for its answer; the message is the user's reply, so the question is dismissed.
    this.questions.dismissAll();
    const files = request.images?.length ? await writeImages(request.images) : null;
    if (files) this.imageSets.push(files);
    try {
      await this.rpc.request("turn/steer", { threadId: this.state.threadId, expectedTurnId: turnId, input: turnInput(request.prompt, files) });
      return { turnId, steered: true };
    } catch (error) {
      if (!error.rpcError) throw error;
      await ended;
      if (this.closed) throw sessionClosedError();
      return this.startTurn(request);
    }
  }

  async start(model, policy) {
    const rpc = this.createRpc({ command: this.command, cwd: this.cwd, ...(this.env ? { env: this.env } : {}) });
    this.rpc = rpc;
    rpc.on("notification", ({ method, params }) => this.handleNotification(method, params));
    rpc.on("request", ({ id, method, params }) => this.handleServerRequest(id, method, params));
    rpc.on("exit", ({ detail, signal }) => this.handleExit(detail, signal));
    rpc.start();
    await rpc.request("initialize", {
      clientInfo: { name: "milagre", title: "Milagre", version: this.clientVersion },
      capabilities: this.analysisOnly ? { experimentalApi: true } : null,
    });
    rpc.notify("initialized");
    await this.checkLogin(rpc);
    // The Chat's linked tools reach Codex as an MCP server in the thread's config (see linked-mcp-server.cjs).
    const url = this.linked ? await this.linked.url().catch(() => null) : null;
    // A constrained session must discover and disable every inherited server. Failure cannot fall back
    // to the ordinary Chat policy because that would expose the user's external tools to an advisor.
    const inherited = this.analysisOnly ? (await rpc.request("config/read", { cwd: this.cwd })).config : null;
    // Settings › MCP: Everywhere servers join the thread, and servers switched off for this account are disabled.
    const extras = !this.analysisOnly && this.mcpExtras ? await readMcpExtras(this) : null;
    const extraServers = {
      ...Object.fromEntries((extras?.servers ?? []).map((def) => [def.name, toCodexConfig(def)])),
      // Merged into the user's own definition by Codex (Task 1, probe step 4).
      ...Object.fromEntries((extras?.off ?? []).map((name) => [name, { enabled: false }])),
    };
    // The names a retry may drop: off servers are not in this list (they are only kept off), so Everywhere servers
    // never share a name with an off entry.
    this.everywhereNames = new Set((extras?.servers ?? []).map((def) => def.name));
    const servers = { ...extraServers, ...(url ? { milagre: { url, tool_timeout_sec: 86400 } } : {}) };
    let config = this.analysisOnly
      ? advisorCodexConfig(inherited, url)
      : Object.keys(servers).length
        ? { ...THREAD_CONFIG, mcp_servers: servers }
        : THREAD_CONFIG;
    if (this.executionAdvisor)
      config = { ...config, features: { ...config.features, default_mode_request_user_input: false, multi_agent: false, multi_agent_v2: false } };
    const threadParams = {
      cwd: this.cwd,
      model,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      developerInstructions: sessionInstructions(this),
      ...(this.analysisOnly ? { environments: [] } : {}),
      config,
    };
    const thread = this.resumeId ? await this.resume(threadParams) : (await this.requestThread("thread/start", threadParams)).thread;
    if (thread?.id && thread.id !== this.state.threadId) {
      this.state.threadId = thread.id;
      this.emit({ type: "session-started", nativeId: thread.id });
    }
    this.ready = true;
  }

  // A logged-out Codex accepts a turn, retries for about 15 s and fails it with a raw 401. account/read
  // answers at once: no account while OpenAI auth is required means `codex login` is needed. A Codex that
  // can't answer, or one on a provider that needs no OpenAI login, isn't held up.
  async checkLogin(rpc) {
    const status = await rpc.request("account/read", { refreshToken: false }, { timeoutMs: ACCOUNT_TIMEOUT_MS }).catch(() => null);
    // Only where OpenAI auth is required does a 401 mid-session mean "log in" (see mapCodexNotification).
    this.state.requiresOpenaiAuth = status?.requiresOpenaiAuth === true;
    if (status && !status.account && status.requiresOpenaiAuth === true) throw Object.assign(new Error(loginMessage("codex")), { notice: true, login: true });
  }

  // Codex ignores a feature it doesn't know, but a Codex that rejects `config` outright would leave the
  // chat unusable. On an RPC error the call is tried again with less: without the Everywhere servers (the
  // switched-off entries and the linked tools stay), then with only the linked tools' MCP server, then without
  // any MCP server (the Chat then only receives Delegations), then without any config (no question tool either).
  // Neither call has a time limit, as in T3 Code and Paseo: Codex answers only after watching every skill folder,
  // which a busy fseventsd stretched past a minute. A Codex that exits fails the call, and Stop kills a stuck start.
  async requestThread(method, params) {
    if (this.analysisOnly || this.executionAdvisor) return this.rpc.request(method, params, { timeoutMs: THREAD_TIMEOUT_MS });
    const { mcp_servers: servers, ...rest } = params.config ?? {};
    const { config: _config, ...bare } = params;
    const withServers = (map) => ({ ...params, config: map && Object.keys(map).length ? { ...rest, mcp_servers: map } : rest });
    const everywhere = this.everywhereNames ?? new Set();
    const withoutEverywhere = Object.fromEntries(Object.entries(servers ?? {}).filter(([name]) => !everywhere.has(name)));
    const stages = [
      params,
      ...(servers ? [withServers(withoutEverywhere), withServers(servers.milagre ? { milagre: servers.milagre } : null), withServers(null)] : []),
      ...(params.config ? [bare] : []),
    ];
    const attempts = stages.filter((attempt, index) => stages.findIndex((other) => isDeepStrictEqual(other, attempt)) === index);
    for (const [index, attempt] of attempts.entries()) {
      try {
        const result = await this.rpc.request(method, attempt, { timeoutMs: THREAD_TIMEOUT_MS });
        if (servers?.milagre) this.linked?.toolsAvailable(Boolean(attempt.config?.mcp_servers?.milagre));
        return result;
      } catch (error) {
        if (!error.rpcError || index === attempts.length - 1) throw error;
      }
    }
  }

  async resume(threadParams) {
    const params = { ...threadParams, threadId: this.resumeId };
    try {
      return (await this.requestThread("thread/resume", params)).thread;
    } catch (first) {
      // Only an answer from Codex itself means the thread is gone; timeouts and exits keep the saved id.
      if (!first.rpcError) throw first;
      try {
        await this.rpc.request("thread/unarchive", { threadId: this.resumeId });
        return (await this.requestThread("thread/resume", params)).thread;
      } catch (second) {
        if (!second.rpcError) throw second;
        throw Object.assign(new Error(RESUME_FAILED_MESSAGE), { resumeFailed: true });
      }
    }
  }

  handleNotification(method, params) {
    if (method === "item/started" && params.item?.type === "fileChange") this.fileChanges.set(params.item.id, params.item.changes ?? []);
    if (method === "serverRequest/resolved") {
      this.permissions.forget(String(params.requestId));
      this.questions.forget(String(params.requestId));
    }
    // A turn this session isn't running (its start acknowledgement timed out) would open a run nothing ends.
    if (method === "turn/started" && !this.turnActive && !this.state.subagents?.has(params.threadId)) return;
    if (method === "turn/started" && params.threadId === this.state.threadId) this.state.turnId ??= params.turn?.id ?? null;
    if (method === "item/completed" && params.item?.type === "imageGeneration") params = { ...params, item: saveGeneratedImage(params.item) };
    const events = mapCodexNotification(method, params, this.state).map((event) => this.withRefusal(event));
    // The mapper filters other threads and stale turns before any image is surfaced here.
    if (method === "item/completed" && events.some((event) => event.type === "step-completed" && event.id === String(params.item?.id)))
      events.push(...toolImageEvents(params.item));
    // A message to a finished child changes nothing yet, but marks it for a recheck (subagents.cjs): poll it too.
    const recheck = [...(this.state.subagentRecheckUntil?.values() ?? [])].some((until) => until > Date.now());
    if (recheck || events.some((event) => event.type === "subagent-update")) this.scheduleSubagents();
    if (!events.some(isTerminal)) {
      events.forEach((event) => this.emit(event));
      return;
    }
    const loggedOut = !this.cancelRequested && events.some((event) => event.login);
    const finished = this.finishTurn(this.cancelRequested ? events.map((event) => (isTerminal(event) ? { type: "turn-cancelled" } : event)) : events);
    // An app-server that answered 401 holds the old credentials; the next message starts a fresh one.
    if (loggedOut) void finished.then(() => this.close());
    else void finished;
  }

  // A command a babysit Run's level refused ends as a step that says why, rather than "Declined.".
  withRefusal(event) {
    const refused = event.type === "step-completed" ? this.refused.get(event.id) : undefined;
    if (!refused) return event;
    this.refused.delete(event.id);
    return { ...event, detail: `$ ${refused.command}\n${refused.reason}` };
  }

  // Native children need not be subscribed on the parent's connection. Read their history
  // without resuming them, then route it through the same child-only event mapper.
  shouldPollSubagent(agent) {
    return activeSubagent(agent) || (this.state.subagentRecheckUntil?.get(agent.id) ?? 0) > Date.now();
  }

  scheduleSubagents() {
    if (this.closed || this.subagentTimer) return;
    this.subagentTimer = setTimeout(async () => {
      this.subagentTimer = null;
      await this.refreshSubagents();
      if ([...(this.state.subagents?.values() ?? [])].some((agent) => this.shouldPollSubagent(agent))) this.scheduleSubagents();
    }, 1500);
    this.subagentTimer.unref?.();
  }

  async readSubagentThread(threadId, previous) {
    const { thread } = await this.rpc.request("thread/read", { threadId }, { timeoutMs: 5000 });
    // The opposite-direction cursor includes its anchor turn, so an active item can
    // grow without getting lost. A one-turn descending page gives the next anchor.
    const newest = await this.rpc.request(
      "thread/turns/list",
      {
        threadId,
        limit: previous?.cursor ? 1 : 20,
        sortDirection: "desc",
        itemsView: "full",
      },
      { timeoutMs: 5000 },
    );
    if (!previous?.cursor) return { ...thread, turns: newest.data.toReversed(), cursor: newest.backwardsCursor };
    const turns = [];
    let cursor = previous.cursor;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const page = await this.rpc.request(
        "thread/turns/list",
        {
          threadId,
          cursor,
          limit: 20,
          sortDirection: "asc",
          itemsView: "full",
        },
        { timeoutMs: 5000 },
      );
      turns.push(...page.data);
      cursor = page.nextCursor;
    }
    return { ...thread, turns, cursor: newest.backwardsCursor ?? previous.cursor };
  }

  refreshSubagents() {
    // A timer and a final refresh may overlap. One cursor owner prevents stale results.
    if (this.refreshingChildren) return this.refreshingChildren;
    this.refreshingChildren = this.pollSubagents().finally(() => {
      this.refreshingChildren = null;
    });
    return this.refreshingChildren;
  }

  async pollSubagents() {
    this.childHistory ??= new Map();
    // A copy: subagent state can change while each history read awaits.
    for (const agent of Array.from(this.state.subagents?.values() ?? [])) {
      if (this.closed) return;
      const previous = this.childHistory.get(agent.id);
      if (!this.shouldPollSubagent(agent) && previous?.finished) continue;
      try {
        const thread = await this.readSubagentThread(agent.id, previous);
        if (this.closed) return;
        const turns = thread?.turns ?? [];
        const items = new Map();
        for (const turn of turns) {
          const completed = ["completed", "failed", "interrupted"].includes(turn.status);
          for (const item of turn.items ?? []) {
            const itemKey = `${turn.id}:${item.id}`;
            const old = previous?.items.get(itemKey);
            // Completed item ids are stable. Only the active turn's items need a
            // content comparison; never serialize the thread history for a fingerprint.
            items.set(itemKey, completed ? null : item);
            if (old === null || (old !== undefined && isDeepStrictEqual(old, item))) continue;
            for (const event of mapCodexNotification("item/completed", { threadId: agent.id, item }, this.state)) this.emit(event);
          }
        }
        const last = turns.at(-1);
        const outcome = { status: thread?.status, turnId: last?.id, turnStatus: last?.status };
        if (!isDeepStrictEqual(previous?.outcome, outcome) || previous?.agentStatus !== this.state.subagents.get(agent.id)?.status) {
          if (["active", "systemError"].includes(thread?.status?.type)) {
            for (const event of mapCodexNotification("thread/status/changed", { threadId: agent.id, status: thread.status }, this.state)) this.emit(event);
          } else if (last?.status === "inProgress") {
            for (const event of mapCodexNotification("turn/started", { threadId: agent.id, turn: last }, this.state)) this.emit(event);
          } else if (last && ["completed", "failed", "interrupted"].includes(last.status)) {
            for (const event of mapCodexNotification("turn/completed", { threadId: agent.id, turn: last }, this.state)) this.emit(event);
          }
        }
        const current = this.state.subagents.get(agent.id);
        this.childHistory.set(agent.id, { cursor: thread.cursor, items, outcome, agentStatus: current.status, finished: !activeSubagent(current) });
      } catch {
        // A live child may not have flushed its history yet. Retry from the last cursor.
      }
    }
  }

  handleServerRequest(id, method, params = {}) {
    if (method === "mcpServer/elicitation/request") {
      const request = codexMcpRequest(id, params);
      const answer = (decision) => this.reply(id, codexMcpResponse(decision));
      if (!this.turnActive || this.cancelRequested || this.closed) answer("cancelled");
      else if (this.analysisOnly || !request) answer("deny");
      else if (isCodexPlanToolApproval(params)) answer("allow");
      else this.permissions.add(request, answer);
      return;
    }
    const answer = (decision) => this.reply(id, { decision: codexDecision(decision) });
    const approval = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
    // A request that arrives once its turn has stopped has nobody to ask.
    if (approval && this.analysisOnly) answer("deny");
    else if (approval && (!this.turnActive || this.cancelRequested || this.closed)) answer("cancelled");
    else if (method === "item/commandExecution/requestApproval") {
      const request = codexCommandRequest(id, params);
      // A babysit Run's level refuses it before any card or mode can allow it. Codex takes no reason with a decline.
      const reason = this.guard ? babysitDenial(request.command, this.guard) : null;
      if (reason) {
        if (params.itemId) this.refused.set(String(params.itemId), { command: request.command, reason });
        answer("deny");
      } else this.permissions.add(request, answer);
    } else if (method === "item/fileChange/requestApproval") {
      const request = codexFileRequest(id, params, this.fileChanges.get(params.itemId));
      const decided = params.grantRoot ? null : this.access.answer(request, this.permissions.mode);
      if (decided) answer(decided.decision);
      else this.permissions.add(request, answer, { inWorkspace: !params.grantRoot && this.access.contains(request.files) });
    } else if (method === "item/tool/requestUserInput" && (this.analysisOnly || this.executionAdvisor)) this.reply(id, codexQuestionResponse("dismissed"));
    else if (method === "item/tool/requestUserInput") this.askQuestion(id, params);
    // Granting extra sandbox permissions is out of scope: grant none, for this turn only.
    else if (method === "item/permissions/requestApproval") this.reply(id, { permissions: {}, scope: "turn" });
    else {
      try {
        this.rpc.respondError(id, `Milagre does not support ${method} yet.`);
      } catch {}
    }
  }

  // Codex may already have exited; then there is nobody left to answer.
  reply(id, result) {
    try {
      this.rpc?.respond(id, result);
    } catch {}
  }

  respondToPermission(requestId, decision) {
    return this.permissions.resolve(requestId, decision);
  }

  // Codex waits on its question until the user answers or dismisses the card, a steering message
  // dismisses it, or the turn stops. A question it can't show, or one asked once its turn has
  // stopped, gets no answers, which Codex reads as "carry on without them".
  askQuestion(id, params) {
    const request = codexQuestionRequest(id, params);
    if (!request || !this.turnActive || this.cancelRequested || this.closed) {
      this.reply(id, codexQuestionResponse("cancelled"));
      return;
    }
    this.questions.add(request, (outcome, answers) => this.reply(id, codexQuestionResponse(outcome, answers)));
  }

  answerQuestion(requestId, answers) {
    return this.questions.answer(requestId, answers);
  }

  // Codex fixes its approval policy when a turn starts, so a switch mid-turn is applied here (see
  // PendingPermissions); the next turn starts with the new policy.
  setPermissionMode(permissionMode) {
    if (this.analysisOnly) return;
    this.permissions.setMode(permissionMode);
  }

  handleExit(detail, signal) {
    this.closed = true;
    clearTimeout(this.subagentTimer);
    settleSubagents(this.state, this.cancelRequested ? "cancelled" : "failed").forEach((event) => this.emit(event));
    void this.finishTurn([this.cancelRequested ? { type: "turn-cancelled" } : failedWith(crashMessage("codex", detail, { signal }))]);
  }

  async finishTurn(events) {
    if (!this.turnActive) return;
    this.turnActive = false;
    // Bind to this turn's own resolver: a new turn may start while image cleanup is awaited.
    const markEnded = this.markTurnEnded;
    this.markTurnEnded = null;
    clearTimeout(this.interruptTimer);
    this.permissions.cancelAll();
    this.questions.cancelAll();
    this.fileChanges.clear();
    this.refused.clear();
    // A command still running when the turn stopped never completes; the renderer closes its step.
    this.state.steps.clear();
    this.state.thinkingStarts?.clear();
    const imageSets = this.imageSets;
    this.imageSets = [];
    await Promise.all(imageSets.map((files) => files.cleanup().catch(() => {})));
    events.forEach((event) => this.emit(event));
    markEnded?.();
  }

  async interrupt() {
    if (!this.turnActive) return;
    this.cancelRequested = true;
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => void this.stopNow(), this.interruptGraceMs);
    this.permissions.cancelAll();
    this.questions.cancelAll();
    if (!this.state.turnId || !this.rpc) return;
    try {
      await this.rpc.request("turn/interrupt", { threadId: this.state.threadId, turnId: this.state.turnId }, { timeoutMs: this.interruptGraceMs });
    } catch {
      await this.close();
    }
  }

  // Fallback for an interrupt Codex doesn't honour: kill the process, and end the turn
  // ourselves in case nothing was spawned yet (or the exit event never comes).
  async stopNow() {
    await this.close();
    await this.finishTurn([{ type: "turn-cancelled" }]);
  }

  async close() {
    clearTimeout(this.subagentTimer);
    settleSubagents(this.state, "cancelled").forEach((event) => this.emit(event));
    this.permissions.cancelAll();
    this.questions.cancelAll();
    if (this.turnActive) this.cancelRequested = true;
    this.closed = true;
    await this.rpc?.close();
  }
}

// Reopening an idle chat need not start or resume an agent. Only its saved unknown children
// are checked, and history items are never replayed as new output.
async function recoverCodexSubagents({ cwd, command, env, agents, clientVersion = "0.0.0", createRpc = (options) => new CodexRpc(options) }) {
  const unknown = (agents ?? []).filter((agent) => agent.status === "unknown" && !agent.archived);
  if (!command || !unknown.length) return [];
  let rpc;
  try {
    rpc = createRpc({ command, cwd, ...(env ? { env } : {}) });
    rpc.start();
    await rpc.request("initialize", { clientInfo: { name: "milagre", title: "Milagre", version: clientVersion }, capabilities: null }, { timeoutMs: 5000 });
    rpc.notify("initialized");
    const reads = await Promise.allSettled(unknown.map((agent) => readLatestChildTurn(rpc, agent.id)));
    return reads.flatMap((read, index) => {
      if (read.status !== "fulfilled" || read.value?.status?.type === "active") return [];
      const last = read.value?.turns?.at(-1);
      const status = { completed: "completed", failed: "failed", interrupted: "cancelled" }[last?.status];
      if (!status) return [];
      const agent = unknown[index];
      const time = Math.max(Date.now(), agent.updatedAt);
      return [
        {
          type: "subagent-update",
          agent: {
            ...agent,
            status,
            updatedAt: time,
            endedAt: agent.endedAt ?? time,
            ...(agent.latestActivity?.startsWith("Session disconnected.")
              ? { latestActivity: { completed: "Finished", failed: "Failed", cancelled: "Cancelled" }[status] }
              : {}),
          },
        },
      ];
    });
  } catch {
    // A missing provider or unreadable history supplies no new evidence about these children.
    return [];
  } finally {
    await rpc?.close().catch(() => {});
  }
}

module.exports = { CodexSession, codexPolicy, saveGeneratedImage, recoverCodexSubagents };
