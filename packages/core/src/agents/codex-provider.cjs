const { isDeepStrictEqual } = require("node:util");
const { readMcpExtras } = require("../mcp/extras.cjs");
const { active: activeSubagent, settleSubagents } = require("./subagents.cjs");
const fs = require("node:fs/promises");
const { saveToolImage } = require("./tool-image.cjs");
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
const { codexMcpCall, turnGuards } = require("../escalation-guard.cjs");
const { promptImageBlocks } = require("@milagre/shared/prompt-parts");

// Outside Plan mode, Codex offers its question tool (request_user_input) only behind this feature.
const THREAD_CONFIG = { features: { default_mode_request_user_input: true, send_message_to_user_async: false } };

// Milagre permission mode -> Codex policy. Ask asks before any command Codex doesn't already trust,
// Auto only when Codex wants to go beyond the workspace sandbox, and Full never asks.
// sandbox has no network, so a push or a GitHub write can only run once Codex asks to leave it.
// A wake's turn (`readOnly`) runs on Codex's strictest policy whatever the Chat's mode: its sandbox writes nothing and
// reaches no network, and everything Codex doesn't trust as a read asks, which the turn then refuses (EscalationTurn).
function codexPolicy(permissionMode, cwd, workspaceRoots = [], { guarded = false, readOnly = false } = {}) {
  if (readOnly) return { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
  if (permissionMode === "full")
    return { approvalPolicy: guarded ? "untrusted" : "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  return {
    approvalPolicy: permissionMode === "auto" ? "on-request" : "untrusted",
    sandbox: "workspace-write",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [...new Set([cwd, ...workspaceRoots])],
      networkAccess: false,
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
      const file = saveToolImage(dataUrl);
      const id = `${item.id}:image:${index}`;
      events.push({ type: "step-started", step: { id, kind: "image", title: "Image from tool", file } }, { type: "step-completed", id, status: "done", file });
    } catch {}
  }
  return events;
}

const turnInput = (prompt, files) =>
  promptImageBlocks(prompt, files?.paths ?? []).map((block) =>
    block.type === "text" ? { type: "text", text: block.text, text_elements: [] } : { type: "localImage", path: block.image },
  );

// account/read answers in well under a second; a Codex that doesn't is not held up for the default RPC timeout.
const ACCOUNT_TIMEOUT_MS = 8000;
const TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "collabAgentToolCall"]);
// thread/start and thread/resume wait for Codex however long it takes (see requestThread).
const THREAD_TIMEOUT_MS = null;

const sessionClosedError = () => Object.assign(new Error("The agent session closed before this message was sent."), { sessionClosed: true });

async function readLatestChildTurn(rpc, threadId) {
  const { thread } = await rpc.request("thread/read", { threadId }, { timeoutMs: 5000 });
  if (thread?.status?.type === "active") return thread;
  try {
    const page = await rpc.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, { timeoutMs: 5000 });
    return { ...thread, turns: page.data.slice(0, 1) };
  } catch (error) {
    if (!error.rpcError) throw error;
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
      createRpc,
    });
    this.state = { threadId: resumeId ?? null, turnId: null, lastItemId: null, hasText: false, steps: new Set() };
    this.rpc = null;
    this.starting = null;
    this.turnActive = false;
    this.cancelRequested = false;
    this.imageSets = [];
    this.turnReady = Promise.resolve();
    this.turnEnded = Promise.resolve();
    this.ready = false;
    this.closed = false;
    this.permissions = new PendingPermissions((event) => this.emit(event));
    this.questions = new PendingQuestions((event) => this.emit(event));
    this.fileChanges = new Map();
    this.guard = null;
    this.escalation = null;
    this.refused = new Map();
  }

  get nativeId() {
    return this.state.threadId;
  }

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
    Object.assign(
      this,
      turnGuards(request.guard, () => void this.interrupt()),
    );
    Object.assign(this.state, { turnId: null, lastItemId: null, hasText: false, asyncMessages: new Set() });
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
      : codexPolicy(permissionMode, this.cwd, this.access.roots, { guarded: Boolean(this.guard), readOnly: Boolean(this.escalation) });
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
        if (!this.ready) await this.close();
      }
      return { turnId: null, steered: false };
    }
  }

  // A message for the running turn joins it through turn/steer, once the turn has an id. If Codex
  async steer(request) {
    await this.turnReady;
    const ended = this.turnEnded;
    if (!this.turnActive) return this.startTurn(request);
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
    if (request.guard) this.guard = request.guard;
    const turnId = this.state.turnId;
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
    const inherited = this.analysisOnly ? (await rpc.request("config/read", { cwd: this.cwd })).config : null;
    const extras = !this.analysisOnly && this.mcpExtras ? await readMcpExtras(this) : null;
    const extraServers = {
      ...Object.fromEntries((extras?.servers ?? []).map((def) => [def.name, toCodexConfig(def)])),
      // Merged into the user's own definition by Codex (Task 1, probe step 4).
      ...Object.fromEntries((extras?.off ?? []).map((name) => [name, { enabled: false }])),
    };
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
  async checkLogin(rpc) {
    const status = await rpc.request("account/read", { refreshToken: false }, { timeoutMs: ACCOUNT_TIMEOUT_MS }).catch(() => null);
    this.state.requiresOpenaiAuth = status?.requiresOpenaiAuth === true;
    if (status && !status.account && status.requiresOpenaiAuth === true) throw Object.assign(new Error(loginMessage("codex")), { notice: true, login: true });
  }

  // Codex ignores a feature it doesn't know, but a Codex that rejects `config` outright would leave the
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
    if (method === "item/started" && TOOL_ITEMS.has(params.item?.type) && params.threadId === this.state.threadId) this.escalation?.called();
    if (method === "serverRequest/resolved") {
      this.permissions.forget(String(params.requestId));
      this.questions.forget(String(params.requestId));
    }
    if (method === "turn/started" && !this.turnActive && !this.state.subagents?.has(params.threadId)) return;
    if (method === "turn/started" && params.threadId === this.state.threadId) this.state.turnId ??= params.turn?.id ?? null;
    if (method === "item/completed" && params.item?.type === "imageGeneration") params = { ...params, item: saveGeneratedImage(params.item) };
    const events = mapCodexNotification(method, params, this.state).map((event) => this.withRefusal(event));
    if (method === "item/completed" && events.some((event) => event.type === "step-completed" && event.id === String(params.item?.id)))
      events.push(...toolImageEvents(params.item));
    const recheck = [...(this.state.subagentRecheckUntil?.values() ?? [])].some((until) => until > Date.now());
    if (recheck || events.some((event) => event.type === "subagent-update")) this.scheduleSubagents();
    if (!events.some(isTerminal)) {
      events.forEach((event) => this.emit(event));
      return;
    }
    const loggedOut = !this.cancelRequested && events.some((event) => event.login);
    const finished = this.finishTurn(this.cancelRequested ? events.map((event) => (isTerminal(event) ? { type: "turn-cancelled" } : event)) : events);
    if (loggedOut) void finished.then(() => this.close());
    else void finished;
  }

  withRefusal(event) {
    const refused = event.type === "step-completed" ? this.refused.get(event.id) : undefined;
    if (!refused) return event;
    this.refused.delete(event.id);
    return { ...event, detail: `$ ${refused.command}\n${refused.reason}` };
  }

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
    if (this.refreshingChildren) return this.refreshingChildren;
    this.refreshingChildren = this.pollSubagents().finally(() => {
      this.refreshingChildren = null;
    });
    return this.refreshingChildren;
  }

  async pollSubagents() {
    this.childHistory ??= new Map();
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
      } catch {}
    }
  }

  handleServerRequest(id, method, params = {}) {
    if (method === "mcpServer/elicitation/request") {
      const request = codexMcpRequest(id, params);
      const answer = (decision) => this.reply(id, codexMcpResponse(decision));
      if (!this.turnActive || this.cancelRequested || this.closed) answer("cancelled");
      else if (this.analysisOnly || !request) answer("deny");
      else if (this.escalation) answer(this.escalation.denial(codexMcpCall(params, this.linked?.tools)) ? "deny" : "allow");
      else if (isCodexPlanToolApproval(params)) answer("allow");
      else this.permissions.add(request, answer);
      return;
    }
    const answer = (decision) => this.reply(id, { decision: codexDecision(decision) });
    const approval = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
    if (approval && this.analysisOnly) answer("deny");
    else if (approval && (!this.turnActive || this.cancelRequested || this.closed)) answer("cancelled");
    else if (approval && this.escalation) answer("deny");
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
    } else if (method === "item/tool/requestUserInput" && (this.analysisOnly || this.executionAdvisor || this.escalation))
      this.reply(id, codexQuestionResponse("dismissed"));
    else if (method === "item/tool/requestUserInput") this.askQuestion(id, params);
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
    this.escalation = null;
    const markEnded = this.markTurnEnded;
    this.markTurnEnded = null;
    clearTimeout(this.interruptTimer);
    this.permissions.cancelAll();
    this.questions.cancelAll();
    this.fileChanges.clear();
    this.refused.clear();
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
    return [];
  } finally {
    await rpc?.close().catch(() => {});
  }
}

module.exports = { CodexSession, codexPolicy, saveGeneratedImage, recoverCodexSubagents };
