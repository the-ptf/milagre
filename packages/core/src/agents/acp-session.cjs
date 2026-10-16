const fs = require("node:fs/promises");
const { readMcpExtras } = require("../mcp/extras.cjs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { cliName } = require("@milagre/shared/providers");
const { AcpRpc } = require("./acp-rpc.cjs");
const { toAcpServer } = require("../mcp/definitions.cjs");
const {
  acpDiffText,
  closeThinking,
  createsFile,
  commandOf,
  cwdOf,
  diffsOf,
  fileOf,
  isQuestionCall,
  mapAcpUpdate,
  readConfigOptions,
  stopReasonEvent,
} = require("./acp-events.cjs");
const { milagreInstructions, RESUME_FAILED_MESSAGE, crashMessage, failedWith, loginMessage, missingCliMessage } = require("./events.cjs");
const { PendingPermissions, capText, insideWorkspace, isAcpPlanToolPermission, unwrapShell } = require("./permissions.cjs");
const { PendingQuestions } = require("./questions.cjs");
const { antigravityAcp, makeTempDir } = require("./antigravity-acp.cjs");

// A chat's session with an Agent Client Protocol agent (docs/adr/0006-antigravity-over-acp.md). The public
// surface matches CodexSession, which SessionManager and ChatHost rely on. What is specific to one agent
// (command, environment, permission modes, how it says "sign in") comes from `config`; see antigravity-acp.cjs.
//
// One agent process per session, started on the first turn: initialize, then session/new (or
// session/resume for a saved id, else session/load with its replayed history dropped). Each turn is one
// session/prompt request: its updates stream as session/update notifications and its response carries
// the stopReason that ends the turn. ACP has no system prompt, so Milagre's instructions go first in the
// first prompt each process sends. ACP can't steer a running turn: a message sent while one runs waits
// and starts the next turn, unless Stop ends that turn first. Stop sends session/cancel; an agent that doesn't end the turn within the
// grace period is killed, and the next turn resumes the session in a new process.

const INITIALIZE_TIMEOUT_MS = 120_000;
const SESSION_TIMEOUT_MS = 120_000;
const CONFIG_TIMEOUT_MS = 15_000;
// State-only updates still apply between turns.
const STATE_UPDATES = new Set(["usage_update", "current_mode_update", "config_option_update", "available_commands_update"]);

const sessionClosedError = () => Object.assign(new Error("The agent session closed before this message was sent."), { sessionClosed: true });

const str = (value) => (typeof value === "string" ? value.trim() : "");

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

// "Running view_file", "Run create_file?" -> "view_file".
const toolName = (call) => /^(?:Running|Run)\s+([\w.:-]+)\??$/.exec(str(call.title))?.[1] ?? (str(call.title) || "a tool");

// session/request_permission params -> the permission-request shape (see permissions.cjs).
function acpPermissionRequest(requestId, call, options) {
  const base = {
    requestId,
    allowForChat: options.some((option) => option?.kind === "allow_always"),
    stepId: call.toolCallId ? String(call.toolCallId) : undefined,
  };
  if (call.kind === "execute") {
    const command = unwrapShell(commandOf(call));
    return compact({ ...base, kind: "command", tool: "Shell", title: "Run this command?", command, cwd: cwdOf(call) });
  }
  if (["edit", "delete", "move"].includes(call.kind)) {
    const diffs = diffsOf(call);
    const files = [...new Set([...diffs.map((diff) => diff.path), ...(call.locations ?? []).map((location) => location?.path).filter(Boolean)])];
    const file = files[0] ?? fileOf(call);
    const created = createsFile(diffs[0]);
    const verb = call.kind === "delete" ? "Delete" : call.kind === "move" ? "Move" : created ? "Create" : "Edit";
    const title = files.length > 1 ? `${verb === "Create" ? "Edit" : verb} ${files.length} files?` : `${verb} ${file ? path.basename(file) : "a file"}?`;
    return compact({ ...base, kind: "edit", tool: "Edit files", title, files: files.length ? files : file ? [file] : [], diff: acpDiffText(diffs) });
  }
  const name = toolName(call);
  let detail;
  try {
    detail = call.rawInput === undefined ? undefined : capText(JSON.stringify(call.rawInput, null, 2));
  } catch {}
  const title = str(call.title).endsWith("?") ? str(call.title) : `Use ${name}?`;
  return compact({ ...base, kind: "other", tool: name, title, detail });
}

// The user's decision -> the agent's option. Allow for chat falls back to allow once, and the reverse.
function pickOption(options, decision) {
  const of = (kind) => options.find((option) => option?.kind === kind);
  if (decision === "allow") return of("allow_once") ?? of("allow_always");
  if (decision === "allow-for-chat") return of("allow_always") ?? of("allow_once");
  if (decision === "deny") return of("reject_once") ?? of("reject_always");
  return null;
}

// Antigravity doesn't take the session's cwd as its working directory on its own: without this it guessed its
// profile's skills folder and ran the first command there.
function workspaceNote(cwd, roots = []) {
  const others = roots.filter((root) => root !== cwd);
  return [
    `Your working directory is ${cwd}. Run commands there unless the user names another folder.`,
    ...(others.length ? [`You may also work in: ${others.join(", ")}.`] : []),
  ].join(" ");
}

const outcome = (option) => (option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });

class AcpSession {
  constructor({
    cwd,
    resumeId,
    command,
    env,
    harness,
    args,
    emit,
    workspaceRoots,
    workspaceInstructions,
    tldrEnabled = true,
    designsEnabled = true,
    linked = null,
    mcpExtras = null,
    clientVersion = "0.0.0",
    interruptGraceMs = 3000,
    config = antigravityAcp,
    createRpc = (options) => new AcpRpc(options),
  }) {
    Object.assign(this, {
      cwd,
      resumeId,
      command,
      env,
      harness,
      args,
      emit,
      workspaceRoots,
      workspaceInstructions,
      tldrEnabled,
      designsEnabled,
      linked,
      mcpExtras,
      clientVersion,
      interruptGraceMs,
      config,
      createRpc,
    });
    this.provider = config.provider;
    this.state = { sessionId: resumeId ?? null, turnId: null, hasText: false, textBreak: false, steps: new Set(), calls: new Map(), editDiffs: new Map() };
    this.rpc = null;
    this.starting = null;
    this.ready = false;
    this.closed = false;
    this.turnActive = false;
    this.cancelRequested = false;
    // Counts Stops, so a message waiting for a turn knows whether Stop ended it.
    this.stops = 0;
    // Milagre's instructions travel with the first prompt each agent process gets.
    this.instructionsSent = false;
    this.replaying = false;
    this.processCount = 0;
    this.tmpdir = null;
    this.turnEnded = Promise.resolve();
    this.markTurnEnded = null;
    this.modeChange = Promise.resolve();
    // Children the agent runs on its own, when the config knows how to see them.
    this.subagents =
      config.subagents?.({
        state: this.state,
        env: env ?? process.env,
        emit: (event) => this.emit(event),
        forward: (update) => this.mapUpdate(update),
        turnActive: () => this.turnActive && !this.cancelRequested,
      }) ?? null;
    this.permissions = new PendingPermissions((event) => this.emit(event));
    this.questions = new PendingQuestions((event) => this.emit(event));
  }

  get nativeId() {
    return this.state.sessionId;
  }

  /** The models the agent offered in its last session/new or session/resume answer: [{ value, name, description }]. */
  get models() {
    return this.state.models ?? null;
  }

  /** The agent model id the session is on, as it last reported. */
  get currentModel() {
    return this.state.model ?? null;
  }

  /** The agent process, while it runs; the ports its commands open belong to the chat. */
  get pid() {
    const child = this.rpc?.child;
    return this.closed || child?.exitCode != null || child?.signalCode != null || child?.killed ? null : (child?.pid ?? null);
  }

  async startTurn(request) {
    if (this.closed) throw sessionClosedError();
    if (this.turnActive) return this.queue(request);
    if (!this.command) {
      this.emit(failedWith(missingCliMessage(this.provider)));
      return { turnId: null, steered: false };
    }
    this.turnActive = true;
    this.cancelRequested = false;
    this.turnEnded = new Promise((resolve) => {
      this.markTurnEnded = resolve;
    });
    return this.beginTurn(request);
  }

  // ACP can't steer: the message waits for the running turn to end and starts the next one. An open
  // question is dismissed, since the message is the user's reply to it. Stop drops the messages sent
  // before it, as it stops a steered message on Claude and Codex; one sent after Stop starts the next turn.
  async queue(request) {
    this.questions.dismissAll();
    const stops = this.stops;
    await this.turnEnded;
    if (this.stops !== stops) return { turnId: null, steered: false, cancelled: true };
    if (this.closed) throw sessionClosedError();
    return this.startTurn(request);
  }

  async beginTurn({ prompt, images = [], model: wanted, effort, permissionMode }) {
    const turnId = randomUUID();
    Object.assign(this.state, { turnId, hasText: false, textBreak: false });
    if (permissionMode) this.permissions.setMode(permissionMode);
    try {
      this.starting ??= this.start();
      await this.starting;
      if (this.cancelRequested || this.closed) {
        await this.finishTurn([{ type: "turn-cancelled" }]);
        return { turnId: null, steered: false };
      }
      // Milagre's model can be a family with efforts (Antigravity); the config turns it into the agent's own id.
      const model = this.config.resolveModel ? this.config.resolveModel({ model: wanted, effort, offered: this.state.models }) : wanted;
      if (model && model !== this.state.model) {
        try {
          await this.setConfig("model", model);
        } catch (error) {
          if (!error.rpcError) throw error;
          throw Object.assign(new Error(`${this.config.name} couldn't switch to ${model}: ${error.message}`), { rpcError: error.rpcError });
        }
      }
      await this.applyMode();
    } catch (error) {
      await this.failStart(error);
      return { turnId: null, steered: false };
    }
    if (this.cancelRequested || this.closed) {
      await this.finishTurn([{ type: "turn-cancelled" }]);
      return { turnId: null, steered: false };
    }
    const blocks = [];
    if (!this.instructionsSent)
      blocks.push({
        type: "text",
        text: `<milagre_instructions>\n${milagreInstructions(this.tldrEnabled, this.workspaceInstructions, this.designsEnabled)}\n\n${workspaceNote(this.cwd, this.workspaceRoots)}\n</milagre_instructions>`,
      });
    blocks.push({ type: "text", text: prompt });
    for (const image of images) blocks.push({ type: "image", mimeType: image.mime, data: image.base64 ?? Buffer.from(image.bytes).toString("base64") });
    this.instructionsSent = true;
    this.subagents?.beginTurn();
    this.emit({ type: "turn-started", turnId });
    this.rpc.request("session/prompt", { sessionId: this.state.sessionId, prompt: blocks }, { timeoutMs: 0 }).then(
      (result) => this.promptEnded(turnId, result),
      (error) => this.promptFailed(turnId, error),
    );
    return { turnId, steered: false };
  }

  async failStart(error) {
    if (error.resumeFailed) {
      await this.finishTurn([{ type: "session-reset" }, failedWith(RESUME_FAILED_MESSAGE)]);
      await this.close();
      return;
    }
    await this.finishTurn([this.cancelRequested ? { type: "turn-cancelled" } : this.failure(error)]);
    // A session that never finished starting, or whose agent isn't signed in, is unusable; the next message starts over.
    if (!this.ready || this.config.isLoginError(error)) await this.close();
  }

  // An error from the agent -> the turn's end.
  failure(error) {
    if (this.config.isLoginError(error)) return failedWith(loginMessage(this.provider), { login: true });
    if (this.config.isSubscriptionError?.(error)) return failedWith(this.config.subscriptionMessage);
    return { type: "turn-failed", message: error.message || `${this.config.name} could not finish this turn.` };
  }

  promptEnded(turnId, result) {
    if (this.state.turnId !== turnId || !this.turnActive) return;
    void this.finishTurn([this.cancelRequested ? { type: "turn-cancelled" } : stopReasonEvent(result?.stopReason, this.config.name)]);
  }

  promptFailed(turnId, error) {
    // An agent that exited ends the turn in handleExit, with its own message.
    if (error.exited || this.state.turnId !== turnId || !this.turnActive) return;
    const login = !this.cancelRequested && this.config.isLoginError(error);
    const finished = this.finishTurn([this.cancelRequested ? { type: "turn-cancelled" } : this.failure(error)]);
    // A process that lost its sign-in holds the old credentials; the next message starts a fresh one.
    if (login) void finished.then(() => this.close());
  }

  async start() {
    const root = this.config.tempRoot;
    if (root) this.tmpdir = await makeTempDir(root, "run");
    if (this.closed) throw sessionClosedError();
    const spawn = this.config.spawn({ command: this.command, args: this.args, harness: this.harness, env: this.env ?? process.env, tmpdir: this.tmpdir });
    this.processCount += 1;
    const rpc = this.createRpc({ command: spawn.command, args: spawn.args, cwd: this.cwd, env: spawn.env, name: cliName(this.provider) });
    this.rpc = rpc;
    rpc.on("notification", ({ method, params }) => this.handleNotification(method, params));
    rpc.on("request", ({ id, method, params }) => this.handleServerRequest(id, method, params));
    rpc.on("exit", (exit) => this.handleExit(exit));
    rpc.start();
    const init = await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        // No fs or terminal: the agent reads, edits and runs commands itself.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "milagre", title: "Milagre", version: this.clientVersion },
      },
      { timeoutMs: INITIALIZE_TIMEOUT_MS },
    );
    this.agentCapabilities = init?.agentCapabilities ?? {};
    // The Chat's linked tools reach the agent as an MCP server (see linked-mcp-server.cjs).
    const url = this.linked ? await this.linked.url().catch(() => null) : null;
    // Settings › MCP: this account's Everywhere servers (the ones switched off are already left out).
    const extras = this.mcpExtras ? await readMcpExtras(this) : null;
    const mcpServers = [...(url ? [{ type: "http", name: "milagre", url, headers: [] }] : []), ...(extras?.servers ?? []).map(toAcpServer)];
    const result = this.state.sessionId ? await this.resume(mcpServers) : await this.requestSession("session/new", { cwd: this.cwd, mcpServers });
    if (typeof result?.modes?.currentModeId === "string") this.state.mode = result.modes.currentModeId;
    readConfigOptions(result?.configOptions, this.state);
    const id = typeof result?.sessionId === "string" ? result.sessionId : this.state.sessionId;
    if (id && id !== this.state.sessionId) {
      this.state.sessionId = id;
      this.emit({ type: "session-started", nativeId: id });
    }
    this.instructionsSent = false;
    this.ready = true;
  }

  // An agent that refuses the linked tools' MCP server gets the session without it; the Chat then only
  // receives Delegations. Sign-in errors aren't retried.
  async requestSession(method, params) {
    const own = params.mcpServers?.filter((server) => server.name === "milagre") ?? [];
    // Without the Everywhere servers first (the linked tools stay), then without any MCP server.
    const attempts = [
      params,
      ...(own.length && own.length < params.mcpServers.length ? [{ ...params, mcpServers: own }] : []),
      ...(params.mcpServers?.length ? [{ ...params, mcpServers: [] }] : []),
    ];
    for (const [index, attempt] of attempts.entries()) {
      try {
        const result = await this.rpc.request(method, attempt, { timeoutMs: SESSION_TIMEOUT_MS });
        if (own.length) this.linked?.toolsAvailable(attempt.mcpServers.some((server) => server.name === "milagre"));
        return result;
      } catch (error) {
        if (!error.rpcError || this.config.isLoginError(error) || this.config.isSubscriptionError?.(error) || index === attempts.length - 1) throw error;
      }
    }
  }

  // session/resume continues without replaying anything. An agent without it, or one that can't resume,
  // gets session/load, whose replayed history is dropped. Only an answer from the agent itself means the
  // session is gone; timeouts and exits keep the saved id.
  async resume(mcpServers) {
    const params = { sessionId: this.state.sessionId, cwd: this.cwd, mcpServers };
    const fatal = (error) => !error.rpcError || this.config.isLoginError(error) || this.config.isSubscriptionError?.(error);
    if (this.agentCapabilities.sessionCapabilities?.resume) {
      try {
        return await this.requestSession("session/resume", params);
      } catch (error) {
        if (fatal(error)) throw error;
      }
    }
    if (this.agentCapabilities.loadSession) {
      this.replaying = true;
      try {
        return await this.requestSession("session/load", params);
      } catch (error) {
        if (fatal(error)) throw error;
      } finally {
        this.replaying = false;
      }
    }
    throw Object.assign(new Error(RESUME_FAILED_MESSAGE), { resumeFailed: true });
  }

  async setConfig(configId, value) {
    const result = await this.rpc.request("session/set_config_option", { sessionId: this.state.sessionId, configId, value }, { timeoutMs: CONFIG_TIMEOUT_MS });
    this.state[configId] = value;
    readConfigOptions(result?.configOptions, this.state);
  }

  // The agent's mode follows Milagre's permission mode. An agent without config options gets session/set_mode;
  // one that refuses both keeps its mode, and the approval cards still follow Milagre's (see PendingPermissions).
  async applyMode() {
    const target = this.config.modes[this.permissions.mode];
    if (!target || target === this.state.mode || !this.rpc || this.closed) return;
    try {
      await this.setConfig("mode", target);
    } catch (error) {
      if (!error.rpcError) throw error;
      try {
        await this.rpc.request("session/set_mode", { sessionId: this.state.sessionId, modeId: target }, { timeoutMs: CONFIG_TIMEOUT_MS });
        this.state.mode = target;
      } catch (second) {
        if (!second.rpcError) throw second;
      }
    }
  }

  handleNotification(method, params = {}) {
    if (method !== "session/update" || this.replaying) return;
    if (params.sessionId && this.state.sessionId && params.sessionId !== this.state.sessionId) return;
    const update = params.update ?? {};
    // A child's tool calls belong to the child, and may come after the parent's turn has ended.
    if (this.subagents?.route(update)) return;
    if (!this.turnActive && !STATE_UPDATES.has(update.sessionUpdate)) return;
    // Once Stop is pressed, Antigravity answers with "The request was cancelled by the client." as reply text.
    if (this.cancelRequested && update.sessionUpdate === "agent_message_chunk") return;
    this.mapUpdate(update);
  }

  mapUpdate(update) {
    for (const event of mapAcpUpdate(update, this.state)) this.emit(event);
  }

  handleServerRequest(id, method, params = {}) {
    if (method === "session/request_permission") {
      this.askPermission(id, params);
      return;
    }
    try {
      this.rpc.respondError(id, `Milagre does not support ${method}.`);
    } catch {}
  }

  // The agent may already have exited; then there is nobody left to answer.
  reply(id, result) {
    try {
      this.rpc?.respond(id, result);
    } catch {}
  }

  askPermission(id, params) {
    const options = Array.isArray(params.options) ? params.options : [];
    const toolCall = params.toolCall ?? {};
    // A request that arrives once its turn has stopped has nobody to ask.
    if (!this.turnActive || this.cancelRequested || this.closed) {
      this.reply(id, outcome(null));
      return;
    }
    if (isAcpPlanToolPermission(params)) {
      this.reply(id, outcome(pickOption(options, "allow")));
      return;
    }
    const requestId = `${this.processCount}:${id}`;
    if (isQuestionCall(toolCall.toolCallId)) {
      this.askQuestion(id, requestId, toolCall, options);
      return;
    }
    const known = this.state.calls.get(String(toolCall.toolCallId ?? "")) ?? {};
    const call = { ...known, ...toolCall, rawInput: { ...known.rawInput, ...toolCall.rawInput } };
    if (!toolCall.rawInput && !known.rawInput) delete call.rawInput;
    const request = acpPermissionRequest(requestId, call, options);
    const roots = [this.cwd, ...(this.workspaceRoots ?? [])];
    // Resolved through symlinks: the agent names files by their real path (/private/var/… on macOS).
    const inWorkspace = request.kind === "edit" && request.files.length > 0 && insideWorkspace(roots, request.files, this.cwd);
    this.permissions.add(request, (decision) => this.reply(id, outcome(pickOption(options, decision))), { inWorkspace });
  }

  // Antigravity asks the user to choose through a permission request whose tool call id starts with
  // `interaction_`: the title is the question and the options are the choices, with no typed answer.
  askQuestion(id, requestId, toolCall, options) {
    const question = str(toolCall.title);
    const choices = options.filter((option) => str(option?.name));
    if (!question || !choices.length) {
      this.reply(id, outcome(null));
      return;
    }
    const request = {
      requestId,
      questions: [
        {
          id: "0",
          header: "",
          question,
          options: choices.map((option) => ({ label: str(option.name) })),
          multiSelect: false,
          allowOther: false,
          secret: false,
        },
      ],
    };
    this.questions.add(request, (result, answers) => {
      const label = result === "answered" ? answers["0"]?.[0] : null;
      this.reply(id, outcome(label ? choices.find((option) => str(option.name) === label) : null));
    });
  }

  answerQuestion(requestId, answers) {
    return this.questions.answer(requestId, answers);
  }

  respondToPermission(requestId, decision) {
    return this.permissions.resolve(requestId, decision);
  }

  // A switch mid-turn answers the waiting cards it covers (see PendingPermissions) and moves the agent's own mode.
  setPermissionMode(permissionMode) {
    this.permissions.setMode(permissionMode);
    if (!this.ready || this.closed) return this.modeChange;
    this.modeChange = this.modeChange.then(() => this.applyMode()).catch(() => {});
    return this.modeChange;
  }

  handleExit({ detail, signal, code, error }) {
    this.closed = true;
    this.subagents?.close(this.cancelRequested ? "cancelled" : "failed");
    void this.removeTemp();
    const reason =
      error?.code === "ENOENT"
        ? detail
        : this.config.crashDetail(this.rpc?.stderr) || (error ? detail : code ? `${cliName(this.provider)} exited with code ${code}` : "");
    void this.finishTurn([this.cancelRequested ? { type: "turn-cancelled" } : failedWith(crashMessage(this.provider, reason, { signal }))]);
  }

  async finishTurn(events) {
    if (!this.turnActive) return;
    this.turnActive = false;
    const markEnded = this.markTurnEnded;
    this.markTurnEnded = null;
    clearTimeout(this.interruptTimer);
    this.permissions.cancelAll();
    this.questions.cancelAll();
    const thinking = closeThinking(this.state);
    // The transcripts' last word lands in the turn; a stopped turn stops its children too.
    this.subagents?.turnEnded({ cancelled: events.some((event) => event.type === "turn-cancelled") });
    // A tool still running when the turn stopped never completes; the renderer closes its step.
    this.state.steps.clear();
    this.state.calls.clear();
    this.state.editDiffs.clear();
    [...thinking, ...events].forEach((event) => this.emit(event));
    markEnded?.();
  }

  async interrupt() {
    if (!this.turnActive) return;
    if (!this.cancelRequested) this.stops += 1;
    this.cancelRequested = true;
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => void this.stopNow(), this.interruptGraceMs);
    this.interruptTimer.unref?.();
    // ACP: after session/cancel the client answers every waiting permission request as cancelled.
    if (this.ready && this.state.sessionId && this.rpc && !this.closed) {
      try {
        this.rpc.notify("session/cancel", { sessionId: this.state.sessionId });
      } catch {}
    }
    this.permissions.cancelAll();
    this.questions.cancelAll();
  }

  // Fallback for a cancel the agent doesn't honour: kill the process and the commands it started, then
  // end the turn ourselves. Antigravity holds a cancel until its background commands finish, and runs
  // them outside its process group. The next turn resumes the session in a new process.
  async stopNow() {
    await this.close({ descendants: true });
    await this.finishTurn([{ type: "turn-cancelled" }]);
  }

  // An exit starts the removal without waiting; close() then waits for that same removal instead of finding nothing to do.
  removeTemp() {
    const directory = this.tmpdir;
    this.tmpdir = null;
    if (directory) this.removing = fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    return this.removing ?? Promise.resolve();
  }

  async close({ descendants = false } = {}) {
    this.subagents?.close("cancelled");
    this.permissions.cancelAll();
    this.questions.cancelAll();
    if (this.turnActive) this.cancelRequested = true;
    this.closed = true;
    await this.rpc?.close({ descendants });
    await this.removeTemp();
  }
}

module.exports = { AcpSession, acpPermissionRequest, pickOption };
