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
const { sessionInstructions, RESUME_FAILED_MESSAGE, crashMessage, failedWith, loginMessage, missingCliMessage } = require("./events.cjs");
const { PendingPermissions, WorkspaceAccess, capText, insideWorkspace, isAcpPlanToolPermission, unwrapShell, writesRemote } = require("./permissions.cjs");
const { PendingQuestions } = require("./questions.cjs");
const { babysitDenial } = require("../babysit-guard.cjs");
const { acpCall, turnGuards } = require("../escalation-guard.cjs");
const { commandRisk } = require("./command-risk.cjs");
const { antigravityAcp, makeTempDir } = require("./antigravity-acp.cjs");
const { promptImageBlocks } = require("@milagre/shared/prompt-parts");

// the stopReason that ends the turn. ACP has no system prompt, so Milagre's instructions go first in the
// first prompt each process sends. ACP can't steer a running turn: a message sent while one runs waits

const INITIALIZE_TIMEOUT_MS = 120_000;
const SESSION_TIMEOUT_MS = 120_000;
const CONFIG_TIMEOUT_MS = 15_000;
const STATE_UPDATES = new Set(["usage_update", "current_mode_update", "config_option_update", "available_commands_update"]);

const sessionClosedError = () => Object.assign(new Error("The agent session closed before this message was sent."), { sessionClosed: true });

const str = (value) => (typeof value === "string" ? value.trim() : "");

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

const toolName = (call) => /^(?:Running|Run)\s+([\w.:-]+)\??$/.exec(str(call.title))?.[1] ?? (str(call.title) || "a tool");

function acpPermissionRequest(requestId, call, options) {
  const base = {
    requestId,
    allowForChat: options.some((option) => option?.kind === "allow_always"),
    stepId: call.toolCallId ? String(call.toolCallId) : undefined,
  };
  if (call.kind === "execute") {
    const command = unwrapShell(commandOf(call));
    const allowForChat = base.allowForChat && !writesRemote(command);
    return compact({ ...base, allowForChat, kind: "command", tool: "Shell", title: "Run this command?", command, cwd: cwdOf(call) });
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

function pickOption(options, decision, { once = false } = {}) {
  const of = (kind) => options.find((option) => option?.kind === kind);
  if (once && (decision === "allow" || decision === "allow-for-chat")) return of("allow_once") ?? null;
  if (decision === "allow") return of("allow_once") ?? of("allow_always");
  if (decision === "allow-for-chat") return of("allow_always") ?? of("allow_once");
  if (decision === "deny") return of("reject_once") ?? of("reject_always");
  return null;
}

// Antigravity doesn't take the session's cwd as its working directory on its own: without this it guessed its
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
    readOnlyRoots,
    access = new WorkspaceAccess({ cwd, workspaceRoots, readOnlyRoots }),
    workspaceInstructions,
    tldrEnabled = true,
    sharedLink = false,
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
      access,
      workspaceInstructions,
      tldrEnabled,
      sharedLink,
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
    this.stops = 0;
    this.instructionsSent = false;
    this.replaying = false;
    this.processCount = 0;
    this.tmpdir = null;
    this.turnEnded = Promise.resolve();
    this.markTurnEnded = null;
    this.modeChange = Promise.resolve();
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
    this.guard = null;
    this.escalation = null;
    this.refused = new Map();
  }

  get nativeId() {
    return this.state.sessionId;
  }

  get models() {
    return this.state.models ?? null;
  }

  get currentModel() {
    return this.state.model ?? null;
  }

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
    Object.assign(
      this,
      turnGuards(request.guard, () => void this.interrupt()),
    );
    this.turnEnded = new Promise((resolve) => {
      this.markTurnEnded = resolve;
    });
    return this.beginTurn(request);
  }

  // ACP can't steer: the message waits for the running turn to end and starts the next one. The user's messages
  // steered message on Claude and Codex (and stops advisor delivery); one sent after Stop starts the next turn.
  async queue(request) {
    this.questions.dismissAll();
    const stops = this.stops;
    await this.turnEnded;
    if (this.stops !== stops) return { turnId: null, steered: false, cancelled: true };
    if (this.closed) throw sessionClosedError();
    return this.startTurn(request);
  }

  async beginTurn({ prompt, images = [], model: wanted, effort, permissionMode, canStart }) {
    const turnId = randomUUID();
    Object.assign(this.state, { turnId, hasText: false, textBreak: false, turnCredits: undefined });
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
      await this.applyEffort(model ?? this.state.model, effort);
      await this.applyMode();
    } catch (error) {
      await this.failStart(error);
      return { turnId: null, steered: false };
    }
    if (canStart && !canStart()) {
      await this.finishTurn([]);
      return { turnId: null, steered: false, cancelled: true };
    }
    if (this.cancelRequested || this.closed || (this.escalation && !this.inStrictMode())) {
      await this.finishTurn([{ type: "turn-cancelled" }]);
      return { turnId: null, steered: false, cancelled: true };
    }
    const blocks = [];
    if (!this.instructionsSent)
      blocks.push({
        type: "text",
        text: `<milagre_instructions>\n${sessionInstructions(this)}\n\n${workspaceNote(this.cwd, this.access.roots)}\n</milagre_instructions>`,
      });
    for (const block of promptImageBlocks(prompt, images)) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text });
      } else {
        const image = block.image;
        blocks.push({ type: "image", mimeType: image.mime, data: image.base64 ?? Buffer.from(image.bytes).toString("base64") });
      }
    }
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
    if (!this.ready || this.config.isLoginError(error)) await this.close();
  }

  failure(error) {
    if (this.config.isLoginError(error)) return failedWith(loginMessage(this.provider), { login: true });
    if (this.config.isSubscriptionError?.(error)) return failedWith(this.config.subscriptionMessage);
    return { type: "turn-failed", message: error.message || `${this.config.name} could not finish this turn.` };
  }

  promptEnded(turnId, result) {
    if (this.state.turnId !== turnId || !this.turnActive) return;
    const end = this.cancelRequested ? { type: "turn-cancelled" } : stopReasonEvent(result?.stopReason, this.config.name);
    // What the turn cost, when the agent said (Kiro's credits).
    const credits = this.state.turnCredits;
    void this.finishTurn([end.type === "turn-completed" && Number.isFinite(credits) ? { ...end, credits } : end]);
  }

  promptFailed(turnId, error) {
    if (error.exited || this.state.turnId !== turnId || !this.turnActive) return;
    const login = !this.cancelRequested && this.config.isLoginError(error);
    const finished = this.finishTurn([this.cancelRequested ? { type: "turn-cancelled" } : this.failure(error)]);
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
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "milagre", title: "Milagre", version: this.clientVersion },
      },
      { timeoutMs: INITIALIZE_TIMEOUT_MS },
    );
    this.agentCapabilities = init?.agentCapabilities ?? {};
    const url = this.linked ? await this.linked.url().catch(() => null) : null;
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

  async requestSession(method, params) {
    const own = params.mcpServers?.filter((server) => server.name === "milagre") ?? [];
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

  // An agent whose effort is a session option of its own (Kiro's `effortLevel`, offered per model) gets the turn's
  async applyEffort(model, effort) {
    const option = this.config.effortOption;
    const value = option && this.config.resolveEffort?.({ model, effort, offered: this.state.models });
    if (!value || value === this.state[option]) return;
    try {
      await this.setConfig(option, value);
    } catch (error) {
      if (!error.rpcError) throw error;
    }
  }

  async applyMode() {
    const mode = this.escalation ? "ask" : this.guard && this.permissions.mode === "full" ? "auto" : this.permissions.mode;
    const target = this.config.modes[mode] ?? this.config.modes.ask;
    // Kiro's permission mode is its `autopilot` option; its `mode` names its agents (see kiro-acp.cjs).
    const option = this.config.modeOption ?? "mode";
    if (!target || target === this.state[option] || !this.rpc || this.closed) return;
    try {
      await this.setConfig(option, target);
    } catch (error) {
      if (!error.rpcError || option !== "mode") throw error;
      try {
        await this.rpc.request("session/set_mode", { sessionId: this.state.sessionId, modeId: target }, { timeoutMs: CONFIG_TIMEOUT_MS });
        this.state.mode = target;
      } catch (second) {
        if (!second.rpcError) throw second;
      }
    }
  }

  inStrictMode() {
    return this.state[this.config.modeOption ?? "mode"] === this.config.modes.ask;
  }

  handleNotification(method, params = {}) {
    if (method !== "session/update" || this.replaying) return;
    if (params.sessionId && this.state.sessionId && params.sessionId !== this.state.sessionId) return;
    const update = params.update ?? {};
    if (this.subagents?.route(update)) return;
    if (!this.turnActive && !STATE_UPDATES.has(update.sessionUpdate)) return;
    // Once Stop is pressed, Antigravity answers with "The request was cancelled by the client." as reply text.
    if (this.cancelRequested && update.sessionUpdate === "agent_message_chunk") return;
    if (update.sessionUpdate === "tool_call") this.escalation?.called();
    this.mapUpdate(update);
  }

  mapUpdate(update) {
    for (const event of mapAcpUpdate(update, this.state)) this.emit(this.withRefusal(event));
  }

  withRefusal(event) {
    const refused = event.type === "step-completed" ? this.refused.get(event.id) : undefined;
    if (!refused) return event;
    this.refused.delete(event.id);
    return { ...event, detail: `$ ${refused.command}\n${refused.reason}` };
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

  reply(id, result) {
    try {
      this.rpc?.respond(id, result);
    } catch {}
  }

  askPermission(id, params) {
    const options = Array.isArray(params.options) ? params.options : [];
    const toolCall = params.toolCall ?? {};
    if (!this.turnActive || this.cancelRequested || this.closed) {
      this.reply(id, outcome(null));
      return;
    }
    if (this.escalation) {
      const known = this.state.calls.get(String(toolCall.toolCallId ?? "")) ?? {};
      const refused = this.escalation.denial(acpCall({ ...known, ...toolCall }, this.linked?.tools));
      this.reply(id, outcome(isQuestionCall(toolCall.toolCallId) ? null : pickOption(options, refused ? "deny" : "allow")));
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
    // A babysit Run's level refuses it before the workspace, a card or the mode can allow it. ACP takes no reason.
    const reason = this.guard && request.kind === "command" ? babysitDenial(request.command, this.guard) : null;
    if (reason) {
      if (request.stepId) this.refused.set(request.stepId, { command: request.command, reason });
      this.reply(id, outcome(pickOption(options, "deny")));
      return;
    }
    const once = { once: request.kind === "command" && writesRemote(request.command) };
    const decided = this.access.answer(request, this.permissions.mode);
    if (decided) {
      this.reply(id, outcome(pickOption(options, decided.decision, once)));
      return;
    }
    const roots = [this.cwd, ...(this.access.roots ?? [])];
    // Resolved through symlinks: the agent names files by their real path (/private/var/… on macOS).
    const inWorkspace = request.kind === "edit" && request.files.length > 0 && insideWorkspace(roots, request.files, this.cwd);
    // Auto allows changes inside the worktree. An agent whose own mode can't say so (Kiro asks before every edit)
    if (inWorkspace && this.permissions.mode === "auto") {
      this.reply(id, outcome(pickOption(options, "allow", once)));
      return;
    }
    // Auto's risk filter (Kiro): a command that stays inside the worktree runs; a risky one gets a card that says why.
    if (this.config.riskFilter && this.permissions.mode === "auto" && request.kind === "command") {
      const risk = commandRisk(request.command, { cwd: request.cwd ?? this.cwd, roots });
      if (!risk) {
        this.reply(id, outcome(pickOption(options, "allow", once)));
        return;
      }
      request.reason = `${risk[0].toUpperCase()}${risk.slice(1)}.`;
    }
    this.permissions.add(request, (decision) => this.reply(id, outcome(pickOption(options, decision, once))), { inWorkspace });
  }

  // Antigravity asks the user to choose through a permission request whose tool call id starts with
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
    this.escalation = null;
    const markEnded = this.markTurnEnded;
    this.markTurnEnded = null;
    clearTimeout(this.interruptTimer);
    this.permissions.cancelAll();
    this.questions.cancelAll();
    this.refused.clear();
    const thinking = closeThinking(this.state);
    this.subagents?.turnEnded({ cancelled: events.some((event) => event.type === "turn-cancelled") });
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

  // end the turn ourselves. Antigravity holds a cancel until its background commands finish, and runs
  async stopNow() {
    await this.close({ descendants: true });
    await this.finishTurn([{ type: "turn-cancelled" }]);
  }

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
