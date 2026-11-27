const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { promptImageBlocks } = require("@milagre/shared/prompt-parts");
const { LOCAL_PROVIDER, piProviderLabel, resolvePiModel } = require("@milagre/shared/pi-models");
const { COMPACT_COMMAND } = require("@milagre/shared/compaction");
const { readMcpExtras } = require("../mcp/extras.cjs");
const { babysitDenial } = require("../babysit-guard.cjs");
const { claudeCall, turnGuards } = require("../escalation-guard.cjs");
const { commandRisk } = require("./command-risk.cjs");
const { PiRpc } = require("./pi-rpc.cjs");
const { asClaudeTool, assistantError, closeThinking, createTurnMetrics, mapPiEvent } = require("./pi-events.cjs");
const { toolCallRequest, writePiExtension } = require("./pi-extension.cjs");
const { HIDDEN_MODEL_MESSAGE, NO_MODELS_MESSAGE, listPiModels } = require("./pi-profile.cjs");
const { OLLAMA_DOWN_MESSAGE, RESUME_FAILED_MESSAGE, crashMessage, failedWith, missingCliMessage, sessionInstructions } = require("./events.cjs");
const { PendingPermissions, WorkspaceAccess, claudeAccessRequest, claudeRequest, insideWorkspace, writesRemote } = require("./permissions.cjs");
const { PendingQuestions } = require("./questions.cjs");

const PROVIDER = "pi";
const START_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const STATS_TIMEOUT_MS = 5_000;

const sessionClosedError = () => Object.assign(new Error("The agent session closed before this message was sent."), { sessionClosed: true });

function piPrompt(prompt, images = []) {
  const text = [];
  const attached = [];
  for (const block of promptImageBlocks(prompt, images)) {
    if (block.type === "text") text.push(block.text);
    else attached.push({ type: "image", mimeType: block.image.mime, data: block.image.base64 ?? Buffer.from(block.image.bytes).toString("base64") });
  }
  return { message: text.join(""), ...(attached.length ? { images: attached } : {}) };
}

// A local model's context is small, so its MCP tools load through Pi's tool search instead of up front.
function mcpServer(def, deferred) {
  const exposure = deferred ? { exposure: "deferred" } : {};
  if (def.type === "stdio") return { name: def.name, config: { command: def.command, args: def.args ?? [], env: def.env ?? {}, ...exposure } };
  if (def.type === "http") return { name: def.name, config: { url: def.url, headers: def.headers ?? {}, ...exposure } };
  return null;
}

const modelKey = (model) => (model ? `${model.provider}/${model.id}` : null);

function workspaceNote(cwd, roots = []) {
  const others = roots.filter((root) => root !== cwd);
  return [`Your working directory is ${cwd}.`, ...(others.length ? [`You may also work in: ${others.join(", ")}.`] : [])].join(" ");
}

// Pi in RPC mode, from a Milagre-owned Pi profile (PI_CODING_AGENT_DIR; see pi-profile.cjs), running local Ollama
// models and every hosted provider Pi is connected to. Milagre's extension in that profile sends every tool call that
// can change something here first (see pi-extension.cjs). A local model gets the small prompt, no skills and deferred
// MCP tools, so a switch between a local and a hosted model restarts Pi on the same session.
class PiSession {
  constructor({
    cwd,
    resumeId,
    command,
    env,
    args,
    emit,
    workspaceRoots,
    readOnlyRoots,
    access = new WorkspaceAccess({ cwd, workspaceRoots, readOnlyRoots }),
    workspaceInstructions,
    tldrEnabled = true,
    sharedLink = false,
    analysisOnly = false,
    sideChat = false,
    linked = null,
    mcpExtras = null,
    interruptGraceMs = 3000,
    createRpc = (options) => new PiRpc(options),
    syncModels = listPiModels,
  }) {
    Object.assign(this, {
      cwd,
      command,
      env,
      args,
      emit,
      access,
      workspaceInstructions,
      tldrEnabled,
      sharedLink,
      analysisOnly,
      sideChat,
      linked,
      mcpExtras,
      interruptGraceMs,
      createRpc,
      syncModels,
    });
    this.provider = PROVIDER;
    this.localModel = true;
    this.runningLocal = null;
    this.state = { sessionId: resumeId ?? null, turnId: null, hasText: false, textBreak: false, calls: new Map(), outputs: new Map(), cwd };
    this.rpc = null;
    this.starting = null;
    this.ready = false;
    this.closed = false;
    this.turnActive = false;
    this.cancelRequested = false;
    this.stops = 0;
    this.processCount = 0;
    this.model = null;
    this.thinkingLevel = null;
    this.lastMessages = [];
    this.retryError = null;
    this.chatAllowed = new Set();
    this.turnEnded = Promise.resolve();
    this.markTurnEnded = null;
    this.permissions = new PendingPermissions((event) => this.emit(event));
    this.questions = new PendingQuestions((event) => this.emit(event));
    this.guard = null;
    this.escalation = null;
  }

  get nativeId() {
    return this.state.sessionId;
  }

  get pid() {
    const child = this.rpc?.child;
    return this.closed || child?.exitCode != null || child?.signalCode != null || child?.killed ? null : (child?.pid ?? null);
  }

  get profile() {
    return (this.env ?? process.env).PI_CODING_AGENT_DIR;
  }

  async startTurn(request) {
    if (this.closed) throw sessionClosedError();
    if (this.turnActive) return this.steer(request);
    if (!this.command) {
      this.emit(failedWith(missingCliMessage(PROVIDER)));
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

  // Pi takes a message mid-turn as a steer: it lands after the running tool calls, before the next model call.
  async steer(request) {
    if (!this.turnActive || !this.ready || this.cancelRequested || this.closed) {
      const stops = this.stops;
      await this.turnEnded;
      if (this.stops !== stops) return { turnId: null, steered: false, cancelled: true };
      if (this.closed) throw sessionClosedError();
      return this.startTurn(request);
    }
    this.questions.dismissAll();
    if (request.guard && !this.escalation) this.guard = request.guard;
    if (request.permissionMode) this.permissions.setMode(request.permissionMode);
    try {
      await this.rpc.request("steer", piPrompt(request.prompt, request.images), { timeoutMs: COMMAND_TIMEOUT_MS });
    } catch {
      await this.turnEnded;
      if (this.closed) throw sessionClosedError();
      return this.startTurn(request);
    }
    return { turnId: this.state.turnId, steered: true };
  }

  async beginTurn({ prompt, images = [], model: wanted, effort, permissionMode, canStart }) {
    const turnId = randomUUID();
    Object.assign(this.state, { turnId, hasText: false, textBreak: false });
    this.lastMessages = [];
    this.retryError = null;
    if (permissionMode) this.permissions.setMode(permissionMode);
    const model = resolvePiModel(wanted);
    try {
      if (this.ready && model && (model.provider === LOCAL_PROVIDER) !== this.runningLocal) await this.restart();
      this.starting ??= this.start(model);
      await this.starting;
      if (this.cancelRequested || this.closed) {
        await this.finishTurn([{ type: "turn-cancelled" }]);
        return { turnId: null, steered: false };
      }
      if (model && modelKey(model) !== this.model) {
        await this.rpc.request("set_model", { provider: model.provider, modelId: model.id }, { timeoutMs: COMMAND_TIMEOUT_MS });
        this.model = modelKey(model);
      }
      await this.applyEffort(effort);
    } catch (error) {
      await this.failStart(error);
      return { turnId: null, steered: false };
    }
    if (canStart && !canStart()) {
      await this.finishTurn([]);
      return { turnId: null, steered: false, cancelled: true };
    }
    if (this.cancelRequested || this.closed) {
      await this.finishTurn([{ type: "turn-cancelled" }]);
      return { turnId: null, steered: false, cancelled: true };
    }
    this.emit({ type: "turn-started", turnId });
    if (prompt.trim() === COMPACT_COMMAND) {
      void this.compact(turnId);
      return { turnId, steered: false };
    }
    this.metrics = createTurnMetrics();
    this.rpc.request("prompt", piPrompt(prompt, images), { timeoutMs: COMMAND_TIMEOUT_MS }).then(
      (data) => (data?.disposition === "handled" ? this.settled(turnId, { aborted: false }) : undefined),
      (error) => {
        if (error.exited || this.state.turnId !== turnId || !this.turnActive) return;
        void this.finishTurn([this.cancelRequested ? { type: "turn-cancelled" } : { type: "turn-failed", message: error.message }]);
      },
    );
    return { turnId, steered: false };
  }

  // Milagre's Compact (and its automatic compaction) arrives as /compact; Pi compacts through its own command and
  // reports compaction_start and compaction_end like its automatic compaction.
  async compact(turnId) {
    this.metrics = null;
    try {
      await this.rpc.request("compact", {}, { timeoutMs: 0 });
    } catch (error) {
      if (error.exited || this.state.turnId !== turnId) return;
      await this.finishTurn([this.cancelRequested ? { type: "turn-cancelled" } : { type: "turn-failed", message: error.message }]);
      return;
    }
    await this.settled(turnId, { aborted: false });
  }

  async applyEffort(effort) {
    const level = effort ?? "off";
    if (level === this.thinkingLevel) return;
    try {
      await this.rpc.request("set_thinking_level", { level }, { timeoutMs: COMMAND_TIMEOUT_MS });
      this.thinkingLevel = level;
    } catch (error) {
      if (!error.rpcError) throw error;
    }
  }

  async failStart(error) {
    if (error.resumeFailed) {
      await this.finishTurn([{ type: "session-reset" }, failedWith(RESUME_FAILED_MESSAGE)]);
      await this.close();
      return;
    }
    await this.finishTurn([this.cancelRequested ? { type: "turn-cancelled" } : failedWith(error.message || "Pi could not start this turn.")]);
    if (!this.ready) await this.close();
  }

  // Restarts Pi on the same session, for a switch between a local and a hosted model.
  async restart() {
    const rpc = this.rpc;
    this.rpc = null;
    this.ready = false;
    this.starting = null;
    rpc?.removeAllListeners();
    await rpc?.close();
  }

  async pickModel(model) {
    const profile = this.profile;
    if (!profile) throw new Error("Milagre has no Pi profile on this computer.");
    const { local, models, hidden } = await this.syncModels({ command: this.command, profile, env: this.env ?? process.env });
    if (model && hidden?.has(model.provider)) throw new Error(HIDDEN_MODEL_MESSAGE);
    if (model?.provider === LOCAL_PROVIDER && !local) throw new Error(OLLAMA_DOWN_MESSAGE);
    if (model) return model;
    const first = models.find((entry) => entry.recommended) ?? models[0];
    if (!first) throw new Error(NO_MODELS_MESSAGE);
    return resolvePiModel(first.id);
  }

  async start(wanted) {
    const profile = this.profile;
    const model = await this.pickModel(wanted);
    const local = model.provider === LOCAL_PROVIDER;
    this.localModel = local;
    const extension = await writePiExtension(profile);
    if (this.closed) throw sessionClosedError();
    const url = this.linked ? await this.linked.url().catch(() => null) : null;
    const extras = this.mcpExtras && !this.analysisOnly ? await readMcpExtras(this) : null;
    const servers = [
      ...(url ? [{ name: "milagre", config: { url, ...(local ? { exposure: "deferred" } : {}) } }] : []),
      ...(extras?.servers ?? []).map((def) => mcpServer(def, local)).filter(Boolean),
    ];
    const instructions = `${sessionInstructions(this)}\n\n${workspaceNote(this.cwd, this.access.roots)}`;
    const resuming = Boolean(this.state.sessionId);
    const args = [
      ...(this.args ?? []),
      "--mode",
      "rpc",
      "--no-extensions",
      ...(local ? ["--no-skills"] : []),
      "-e",
      extension,
      "--session-dir",
      path.join(profile, "sessions"),
      ...(resuming ? ["--session", this.state.sessionId] : []),
      "--provider",
      model.provider,
      "--model",
      model.id,
      "--append-system-prompt",
      instructions,
    ];
    this.processCount += 1;
    const rpc = this.createRpc({
      command: this.command,
      args,
      cwd: this.cwd,
      env: { ...(this.env ?? process.env), MILAGRE_PI_MCP: JSON.stringify(servers) },
      name: "Pi",
    });
    this.rpc = rpc;
    rpc.on("event", (event) => this.handleEvent(event));
    rpc.on("ui", (request) => this.handleUi(request));
    rpc.on("exit", (exit) => this.handleExit(exit));
    rpc.start();
    let state;
    try {
      state = await rpc.request("get_state", {}, { timeoutMs: START_TIMEOUT_MS });
    } catch (error) {
      if (resuming && error.exited) throw Object.assign(new Error(RESUME_FAILED_MESSAGE), { resumeFailed: true });
      throw error;
    }
    if (url) this.linked?.toolsAvailable(true);
    await rpc.request("set_auto_compaction", { enabled: true }, { timeoutMs: COMMAND_TIMEOUT_MS }).catch(() => {});
    this.model = state?.model?.provider && state?.model?.id ? `${state.model.provider}/${state.model.id}` : modelKey(model);
    this.runningLocal = local;
    this.thinkingLevel = state?.thinkingLevel ?? null;
    const id = typeof state?.sessionId === "string" ? state.sessionId : null;
    if (resuming && id && id !== this.state.sessionId) throw Object.assign(new Error(RESUME_FAILED_MESSAGE), { resumeFailed: true });
    if (id && id !== this.state.sessionId) {
      this.state.sessionId = id;
      this.emit({ type: "session-started", nativeId: id });
    }
    this.ready = true;
  }

  handleEvent(event) {
    if (!this.turnActive) return;
    this.metrics?.event(event);
    if (event.type === "agent_end") {
      this.lastMessages = Array.isArray(event.messages) ? event.messages : [];
      return;
    }
    if (event.type === "auto_retry_end" && event.success === false) {
      this.retryError = typeof event.finalError === "string" ? event.finalError : null;
      return;
    }
    if (event.type === "agent_settled") {
      void this.settled(this.state.turnId, event);
      return;
    }
    if (this.cancelRequested && event.type === "message_update") return;
    if (event.type === "tool_execution_start") this.escalation?.called();
    for (const mapped of mapPiEvent(event, this.state)) this.emit(mapped);
  }

  async settled(turnId, { aborted }) {
    if (this.state.turnId !== turnId || !this.turnActive) return;
    const usage = await this.contextUsage();
    if (this.state.turnId !== turnId || !this.turnActive) return;
    const error = assistantError(this.lastMessages) ?? this.retryError;
    const metrics = this.metrics?.result();
    const completed = metrics ? { type: "turn-completed", metrics } : { type: "turn-completed" };
    const end =
      aborted || this.cancelRequested
        ? { type: "turn-cancelled" }
        : error
          ? { type: "turn-failed", message: `${piProviderLabel(this.model?.split("/")[0] ?? PROVIDER)}: ${error}` }
          : completed;
    await this.finishTurn([...(usage ? [usage] : []), end]);
  }

  async contextUsage() {
    try {
      const stats = await this.rpc.request("get_session_stats", {}, { timeoutMs: STATS_TIMEOUT_MS });
      const { tokens, contextWindow } = stats?.contextUsage ?? {};
      if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
      const cost = Number(stats?.cost);
      return { type: "context-usage", used: tokens, size: contextWindow, ...(cost > 0 ? { cost } : {}) };
    } catch {
      return null;
    }
  }

  handleUi(request) {
    if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
    const call = toolCallRequest(request);
    if (!call) {
      this.answerUi(request.id, { cancelled: true });
      return;
    }
    this.askPermission(request.id, call);
  }

  answerUi(id, answer) {
    try {
      this.rpc?.respondUi(id, answer);
    } catch {}
  }

  decide(id, decision, reason) {
    this.answerUi(id, { value: decision === "allow" || decision === "allow-for-chat" ? "allow" : `deny:${reason ?? ""}` });
  }

  askPermission(id, call) {
    if (!this.turnActive || this.cancelRequested || this.closed) {
      this.decide(id, "deny", "The turn was stopped.");
      return;
    }
    const tool = asClaudeTool(call.toolName, call.input ?? {}, this.cwd);
    if (this.escalation || this.analysisOnly) {
      const guarded = claudeCall(tool.name, tool.input, this.linked?.tools);
      const refused = this.escalation ? this.escalation.denial(guarded) : guarded.readOnly ? null : "This Chat can only read.";
      this.decide(id, refused ? "deny" : "allow", refused ?? undefined);
      return;
    }
    const request = claudeRequest(tool.name, tool.input, { requestId: `${this.processCount}:${id}`, toolUseID: call.toolCallId });
    const reason = this.guard && request.kind === "command" ? babysitDenial(request.command, this.guard) : null;
    if (reason) {
      this.decide(id, "deny", reason);
      return;
    }
    const decided = this.access.answer(claudeAccessRequest(tool.name, tool.input, request), this.permissions.mode);
    if (decided) {
      this.decide(id, decided.decision, decided.message);
      return;
    }
    const rule = request.kind === "command" ? `command:${request.command}` : `tool:${tool.name}`;
    if (this.chatAllowed.has(rule)) {
      this.decide(id, "allow");
      return;
    }
    const roots = [this.cwd, ...(this.access.roots ?? [])];
    const inWorkspace = request.kind === "edit" && request.files?.length > 0 && insideWorkspace(roots, request.files, this.cwd);
    if (inWorkspace && this.permissions.mode === "auto") {
      this.decide(id, "allow");
      return;
    }
    const risk = request.kind === "command" ? commandRisk(request.command, { cwd: this.cwd, roots }) : undefined;
    if (this.permissions.mode === "auto" && risk !== undefined) {
      if (!risk) {
        this.decide(id, "allow");
        return;
      }
      request.reason = `${risk[0].toUpperCase()}${risk.slice(1)}.`;
    }
    request.allowForChat = !(request.kind === "command" && writesRemote(request.command));
    this.permissions.add(
      request,
      (decision) => {
        if (decision === "allow-for-chat") this.chatAllowed.add(rule);
        this.decide(id, decision, decision === "cancelled" ? "The turn was stopped." : undefined);
      },
      { inWorkspace, safeCommand: risk === null },
    );
  }

  answerQuestion(requestId, answers) {
    return this.questions.answer(requestId, answers);
  }

  respondToPermission(requestId, decision) {
    return this.permissions.resolve(requestId, decision);
  }

  async setPermissionMode(permissionMode) {
    this.permissions.setMode(permissionMode);
  }

  handleExit({ detail, signal, code, error }) {
    this.closed = true;
    // While Pi starts, the failed command says why (a resumed session that's gone resets the Chat).
    if (!this.ready) return;
    const reason = error?.code === "ENOENT" ? detail : error ? detail : code ? `Pi exited with code ${code}` : "";
    void this.finishTurn([this.cancelRequested ? { type: "turn-cancelled" } : failedWith(crashMessage(PROVIDER, reason, { signal }))]);
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
    const thinking = closeThinking(this.state);
    const open = [...this.state.calls.keys()].map((id) => ({ type: "step-completed", id, status: "failed" }));
    this.state.calls.clear();
    this.state.outputs.clear();
    [...thinking, ...open, ...events].forEach((event) => this.emit(event));
    markEnded?.();
  }

  async interrupt() {
    if (!this.turnActive) return;
    if (!this.cancelRequested) this.stops += 1;
    this.cancelRequested = true;
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => void this.stopNow(), this.interruptGraceMs);
    this.interruptTimer.unref?.();
    this.permissions.cancelAll();
    this.questions.cancelAll();
    if (!this.ready || !this.rpc || this.closed) return;
    try {
      await this.rpc.request("clear_queue", {}, { timeoutMs: COMMAND_TIMEOUT_MS });
      await this.rpc.request("abort", {}, { timeoutMs: this.interruptGraceMs });
    } catch {}
  }

  async stopNow() {
    await this.close({ descendants: true });
    await this.finishTurn([{ type: "turn-cancelled" }]);
  }

  async close({ descendants = false } = {}) {
    this.permissions.cancelAll();
    this.questions.cancelAll();
    if (this.turnActive) this.cancelRequested = true;
    this.closed = true;
    await this.rpc?.close({ descendants });
  }
}

module.exports = { PiSession, piPrompt };
