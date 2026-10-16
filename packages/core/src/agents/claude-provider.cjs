const { spawnCommand } = require("./command.cjs");
const { readMcpExtras } = require("../mcp/extras.cjs");
const { settleSubagents } = require("./subagents.cjs");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { killTree } = require("./process-tree.cjs");
const { milagreInstructions, RESUME_FAILED_MESSAGE, crashMessage, failedWith, isTerminal, mapClaudeMessage, missingCliMessage } = require("./events.cjs");
const { PendingPermissions, claudeRequest, claudeResult, insideRoot, insideWorkspace } = require("./permissions.cjs");
const { PendingQuestions, claudeQuestionRequest, claudeQuestionResult } = require("./questions.cjs");
const { mcpContent, runTool } = require("../linked-tools.cjs");
const { advisorPolicy, ANALYSIS_INSTRUCTIONS } = require("./advisor-policy.cjs");
const { toClaudeConfig } = require("../mcp/definitions.cjs");

// Milagre permission mode -> Claude Code permission mode. In Ask (`default`) Claude Code checks with
// the user, through canUseTool, before edits and commands its rules don't already allow.
const CLAUDE_MODES = { ask: "default", auto: "acceptEdits", full: "bypassPermissions" };

// Claude Code's built-in terse output style. Unlike text appended to the system prompt, which the SDK
// records with a conversation and ignores on later turns and resumes, the style applies to new chats, to
// resumed chats and to the running query, all through applyFlagSettings before the turn's message.
const CONCISE_STYLE = "Concise";

// Claude Code prints this when --resume names a session it no longer has.
const MISSING_CONVERSATION = /No conversation found/i;

// User messages for a running query: the SDK's streaming-input mode reads this until it ends.
class Inbox {
  constructor() {
    this.queue = [];
    this.wake = null;
    this.ended = false;
  }

  push(message) {
    this.queue.push(message);
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.queue.length) yield this.queue.shift();
      if (this.ended) return;
      await new Promise((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

// The uuid comes back in the result of the turn that reads the message (see mapClaudeMessage).
function userMessage(prompt, images = []) {
  const content = [
    { type: "text", text: prompt },
    ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } })),
  ];
  return { type: "user", uuid: randomUUID(), message: { role: "user", content }, parent_tool_use_id: null };
}

// A Chat's linked tools, served in-process. They are allowed outright: the reads need no approval, and
// `delegate` asks through Milagre's own card (see Delegations), in every provider the same way.
function linkedOptions(tools, sdk) {
  const server = sdk.createSdkMcpServer({
    name: "milagre",
    alwaysLoad: true,
    tools: tools.map((definition) =>
      sdk.tool(
        definition.name,
        definition.description,
        definition.input,
        async (args) => {
          const result = await runTool(definition, args);
          return { content: mcpContent(result), isError: result.isError };
        },
        { annotations: { readOnlyHint: definition.readOnly } },
      ),
    ),
  });
  return { mcpServers: { milagre: server }, allowedTools: tools.map((definition) => `mcp__milagre__${definition.name}`) };
}

const sessionClosedError = () => Object.assign(new Error("The agent session closed before this message was sent."), { sessionClosed: true });

class ClaudeSession {
  constructor({
    cwd,
    resumeId,
    command,
    env,
    emit,
    workspaceRoots,
    workspaceInstructions,
    tldrEnabled = true,
    designsEnabled = true,
    analysisOnly = false,
    linked = null,
    mcpExtras = null,
    loadSdk = () => import("@anthropic-ai/claude-agent-sdk"),
    spawnImpl = spawn,
    interruptGraceMs = 3000,
  }) {
    Object.assign(this, {
      cwd,
      resumeId,
      command,
      env,
      emit,
      workspaceRoots,
      workspaceInstructions,
      tldrEnabled,
      designsEnabled,
      analysisOnly,
      linked,
      mcpExtras,
      loadSdk,
      spawnImpl,
      interruptGraceMs,
    });
    this.state = { sessionId: resumeId ?? null, turnId: null, hasText: false };
    this.query = null;
    this.inbox = null;
    this.child = null;
    this.stderr = "";
    this.turnActive = false;
    this.cancelRequested = false;
    this.closed = false;
    this.permissions = new PendingPermissions((event) => this.emit(event));
    this.questions = new PendingQuestions((event) => this.emit(event));
    // Settles once the running turn's own message is in Claude Code's input (or the turn failed to start).
    this.turnReady = Promise.resolve();
    // Settles when the running turn ends; a message sent while the turn is stopping waits on it.
    this.turnEnded = Promise.resolve();
    this.markEnded = () => {};
  }

  get nativeId() {
    return this.state.sessionId;
  }

  /** The Claude Code process, while it runs; the ports its commands open belong to the chat. */
  get pid() {
    const child = this.child;
    return this.closed || child?.exitCode != null || child?.signalCode != null || child?.killed ? null : (child?.pid ?? null);
  }

  async startTurn(request) {
    if (this.closed) throw Object.assign(new Error("This Claude session is closed."), { sessionClosed: true });
    if (this.turnActive) return this.steer(request);
    if (!this.command) {
      this.emit(failedWith(missingCliMessage("claude")));
      return { turnId: null, steered: false };
    }
    this.turnActive = true;
    this.implicitTurn = false;
    // Whether this turn's init announced a session id (session-started); see readMessages.
    this.announcedId = false;
    this.cancelRequested = false;
    this.turnEnded = new Promise((resolve) => {
      this.markEnded = resolve;
    });
    let markReady;
    this.turnReady = new Promise((resolve) => {
      markReady = resolve;
    });
    try {
      return await this.beginTurn(request);
    } finally {
      markReady();
    }
  }

  async beginTurn({ prompt, images = [], model, permissionMode, effort, ultracode = false, fastMode = false, replies }) {
    const turnId = randomUUID();
    Object.assign(this.state, { turnId, hasText: false });
    this.permissions.setMode(permissionMode);
    try {
      if (!this.query) await this.start(model, this.analysisOnly ? "dontAsk" : (CLAUDE_MODES[permissionMode] ?? "default"), effort, ultracode, fastMode);
      if (!this.closed) {
        if (model !== this.model) {
          await this.query.setModel(model);
          this.model = model;
        }
        // The user may have switched modes while Claude Code was starting.
        const mode = this.analysisOnly ? "dontAsk" : (CLAUDE_MODES[this.permissions.mode] ?? "default");
        if (mode !== this.mode) {
          await this.query.setPermissionMode(mode);
          this.mode = mode;
        }
        // A new effort level alone turns ultracode off, so both keys always travel together.
        if ((effort && effort !== this.effort) || ultracode !== this.ultracode) {
          await this.query.applyFlagSettings({ ...(effort ? { effortLevel: effort } : {}), ultracode });
          this.effort = effort;
          this.ultracode = ultracode;
        }
        if (fastMode !== this.fastMode) {
          await this.query.applyFlagSettings({ fastMode });
          this.fastMode = fastMode;
        }
        await this.applyReplyStyle(replies);
      }
    } catch (error) {
      this.finishTurn({ type: "turn-failed", message: error.message });
      return { turnId: null, steered: false };
    }
    // close() or interrupt() may have landed while the SDK was loading or the query starting.
    if (this.closed) {
      await this.close();
      this.finishTurn({ type: "turn-cancelled" });
      return { turnId: null, steered: false };
    }
    if (this.cancelRequested) {
      this.finishTurn({ type: "turn-cancelled" });
      return { turnId: null, steered: false };
    }
    this.inbox.push(userMessage(prompt, images));
    this.emit({ type: "turn-started", turnId });
    return { turnId, steered: false };
  }

  // Concise is Claude Code's flag-layer outputStyle; Normal clears it (null), which falls back to the style
  // in the user's own Claude settings, exactly what the session would have without Milagre. A CLI that
  // rejects the style costs only the style: it is dropped for this session, never retried, and the turn runs.
  async applyReplyStyle(replies) {
    const wanted = replies === "concise" && !this.styleFailed ? CONCISE_STYLE : null;
    if (wanted === this.outputStyle) return;
    try {
      await this.query.applyFlagSettings({ outputStyle: wanted });
      this.outputStyle = wanted;
    } catch {
      this.styleFailed = true;
    }
  }

  // A message for the running turn goes straight into Claude Code's input. Claude Code picks it up at
  // the next tool boundary; if the turn ends first, it starts a new turn for it (see readMessages).
  async steer(request) {
    await this.turnReady;
    const ended = this.turnEnded;
    // A turn that was asked to stop takes no more messages; this one starts the next turn.
    if (this.cancelRequested) {
      await ended;
      if (this.closed) throw sessionClosedError();
      return this.startTurn(request);
    }
    if (!this.turnActive || !this.inbox || this.closed) return this.startTurn(request);
    // Claude Code holds a message until the question it waits on is settled. The message is the user's
    // reply, so the question is dismissed and the message reaches Claude right away.
    this.questions.dismissAll();
    if (request.permissionMode) await this.setPermissionMode(request.permissionMode);
    this.inbox.push(userMessage(request.prompt, request.images));
    return { turnId: this.state.turnId, steered: true };
  }

  beginImplicitTurn() {
    const turnId = randomUUID();
    this.turnActive = true;
    this.announcedId = false;
    this.cancelRequested = false;
    Object.assign(this.state, { turnId, hasText: false });
    this.turnReady = Promise.resolve();
    this.turnEnded = new Promise((resolve) => {
      this.markEnded = resolve;
    });
    // It runs a steering message the last turn didn't take; that message's sender learns which turn has it.
    this.emit({ type: "turn-started", turnId, ...(this.lastTurnId ? { continues: this.lastTurnId } : {}) });
  }

  async start(model, mode, effort, ultracode = false, fastMode = false) {
    const sdk = await this.loadSdk();
    if (this.closed) return;
    this.stderr = "";
    this.child = null;
    this.inbox = new Inbox();
    this.model = model;
    this.mode = mode;
    this.effort = effort;
    this.ultracode = ultracode;
    this.fastMode = fastMode;
    this.outputStyle = null;
    // Settings › MCP: Everywhere servers join the Chat's servers; off servers are switched off once Claude Code has started.
    // An advisor never gets them, and a failing read never stops the Chat from starting.
    const extras = this.mcpExtras && !this.analysisOnly ? await readMcpExtras(this) : null;
    if (this.closed) return;
    this.mcpOff = extras?.off ?? [];
    const linked = this.linked?.tools.length ? linkedOptions(this.linked.tools, sdk) : {};
    const extraServers = Object.fromEntries((extras?.servers ?? []).map((def) => [def.name, toClaudeConfig(def)]));
    this.query = sdk.query({
      prompt: this.inbox,
      options: {
        // Headless Claude Code hides TaskCreate / TaskUpdate / TaskList, which feed the Chat's task list.
        env: { ...(this.env ?? process.env), CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" },
        cwd: this.cwd,
        ...(this.workspaceRoots ? { additionalDirectories: this.workspaceRoots.filter((root) => root !== this.cwd) } : {}),
        model,
        permissionMode: mode,
        ...(effort ? { effort } : {}),
        settings: { fastMode, ...(ultracode ? { ultracode: true } : {}) },
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        forwardSubagentText: true,
        pathToClaudeCodeExecutable: this.command,
        settingSources: ["user", "project", "local"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: [milagreInstructions(this.tldrEnabled, this.workspaceInstructions, this.designsEnabled), this.analysisOnly ? ANALYSIS_INSTRUCTIONS : ""]
            .filter(Boolean)
            .join("\n\n"),
        },
        ...linked,
        ...(Object.keys(extraServers).length ? { mcpServers: { ...extraServers, ...linked.mcpServers } } : {}),
        canUseTool: (toolName, input, options) =>
          toolName === "AskUserQuestion" ? this.askQuestion(input, options) : this.askPermission(toolName, input, options),
        ...(this.analysisOnly ? advisorPolicy("claude", this.linked?.tools ?? []) : {}),
        ...(this.resumeId ? { resume: this.resumeId } : {}),
        // Own the process so close() can stop Claude Code and everything it started.
        spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
          const child = spawnCommand(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true }, this.spawnImpl);
          child.stderr?.on("data", (chunk) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-4000);
          });
          this.child = child;
          return child;
        },
      },
    });
    void this.readMessages(this.query);
    // Switch the off servers off before the first message, so the first turn never offers them. The init pass in
    // readMessages tries once more.
    for (const name of this.mcpOff) await this.query.toggleMcpServer?.(name, false)?.catch(() => {});
    // Thinking arrives as readable summaries rather than empty blocks, for the reply's thinking steps.
    // Only the display changes (null keeps the model's own thinking budget), so it suits every model.
    await this.query.setMaxThinkingTokens?.(null, "summarized").catch(() => {});
  }

  // Claude Code waits on this promise until the user answers in Milagre, the turn stops, or the SDK
  // aborts the request.
  askPermission(toolName, input, options = {}) {
    // A request that arrives once its turn has stopped has nobody to ask.
    if (!this.turnActive || this.cancelRequested || this.closed) return Promise.resolve(claudeResult("cancelled", input));
    const request = claudeRequest(toolName, input, options);
    return new Promise((resolve) => {
      const abort = () => this.permissions.resolve(request.requestId, "cancelled");
      const inWorkspace =
        !options.blockedPath &&
        Boolean(request.files?.length) &&
        (this.workspaceRoots ? insideWorkspace([this.cwd, ...this.workspaceRoots], request.files, this.cwd) : insideRoot(this.cwd, request.files));
      this.permissions.add(
        request,
        (decision) => {
          options.signal?.removeEventListener("abort", abort);
          resolve(claudeResult(decision, input, options.suggestions));
        },
        { inWorkspace },
      );
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  respondToPermission(requestId, decision) {
    return this.permissions.resolve(requestId, decision);
  }

  // AskUserQuestion reaches canUseTool in every mode, Full included. Claude Code waits on this promise
  // until the user answers or dismisses the card, a steering message dismisses it, the turn stops, or
  // the SDK aborts the request.
  askQuestion(input, options = {}) {
    if (!this.turnActive || this.cancelRequested || this.closed) return Promise.resolve(claudeQuestionResult("cancelled", input));
    const request = claudeQuestionRequest(input, options);
    if (!request) return Promise.resolve(claudeQuestionResult("unshown", input));
    return new Promise((resolve) => {
      const abort = () => this.questions.cancel(request.requestId);
      this.questions.add(request, (outcome, answers) => {
        options.signal?.removeEventListener("abort", abort);
        resolve(claudeQuestionResult(outcome, input, answers));
      });
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  answerQuestion(requestId, answers) {
    return this.questions.answer(requestId, answers);
  }

  // The user switched modes, possibly mid-turn: Claude Code stops asking for what the new mode allows,
  // and the waiting cards it allows are answered (see PendingPermissions).
  async setPermissionMode(permissionMode) {
    if (this.analysisOnly) return;
    this.permissions.setMode(permissionMode);
    const mode = CLAUDE_MODES[permissionMode] ?? "default";
    if (!this.query || this.closed || mode === this.mode) return;
    this.mode = mode;
    try {
      await this.query.setPermissionMode(mode);
    } catch {
      // Forget the mode so the next turn applies it again.
      this.mode = null;
    }
  }

  async readMessages(query) {
    try {
      for await (const message of query) {
        // Claude Code opens every turn with init. One arriving while no turn runs is a turn Claude Code
        // started by itself, for a steering message that came in just as the last turn ended. It starts
        // with its first event, so a turn that only records a task notification never shows.
        if (message.type === "system" && message.subtype === "init" && !this.turnActive && !this.closed) this.implicitTurn = true;
        if (message.type === "system" && message.subtype === "init" && this.mcpOff?.length) {
          const off = this.mcpOff;
          this.mcpOff = [];
          for (const name of off) this.query?.toggleMcpServer?.(name, false)?.catch(() => {});
        }
        for (const event of mapClaudeMessage(message, this.state)) {
          if (this.implicitTurn && !this.turnActive && !this.closed) this.beginImplicitTurn();
          this.implicitTurn = false;
          if (event.type === "session-started") this.announcedId = true;
          if (!isTerminal(event)) this.emit(event);
          else if (this.cancelRequested) this.finishTurn({ type: "turn-cancelled" });
          else if (event.type === "turn-failed" && this.resumeGone(`${event.message}\n${message.errors ?? ""}\n${message.result ?? ""}`)) this.resumeFailed();
          else {
            // A logged-out Claude Code keeps answering "not logged in" until it is restarted, so the session
            // closes and the next message starts a fresh process. The chat forgets a session id only when this
            // very turn's init created it: that chat never got an answer. An id from an earlier turn, or one the
            // session resumed, is a real conversation and stays.
            if (event.login && this.announcedId) this.emit({ type: "session-reset" });
            this.finishTurn(event);
            if (event.login) void this.close();
          }
        }
        if (message.type === "result") this.implicitTurn = false;
      }
      this.handleEnd(query, null);
    } catch (error) {
      this.handleEnd(query, error);
    }
  }

  // Only a "conversation is missing" failure may discard the saved id; spawn errors,
  // crashes and bad paths must keep it.
  resumeGone(text) {
    return Boolean(this.resumeId) && MISSING_CONVERSATION.test(`${text}\n${this.stderr}`);
  }

  handleEnd(query, error) {
    if (query !== this.query) return;
    this.query = null;
    this.closed = true;
    settleSubagents(this.state, this.cancelRequested ? "cancelled" : "failed").forEach((event) => this.emit(event));
    if (!this.turnActive) return;
    if (this.cancelRequested) this.finishTurn({ type: "turn-cancelled" });
    else if (this.resumeGone(error?.message ?? "")) this.resumeFailed();
    else this.finishTurn(failedWith(crashMessage("claude", error?.message || this.stderr)));
  }

  resumeFailed() {
    if (!this.turnActive) return;
    this.emit({ type: "session-reset" });
    this.finishTurn(failedWith(RESUME_FAILED_MESSAGE));
    void this.close();
  }

  finishTurn(event) {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.lastTurnId = this.state.turnId;
    const markEnded = this.markEnded;
    clearTimeout(this.interruptTimer);
    this.permissions.cancelAll();
    this.questions.cancelAll();
    // Tool calls still waiting for a result never get one, nor does thinking that was cut off.
    this.state.tools?.clear();
    this.state.foregroundChildren?.clear();
    this.state.thinking = null;
    this.emit(event);
    markEnded();
  }

  async interrupt() {
    if (!this.turnActive) return;
    this.cancelRequested = true;
    clearTimeout(this.interruptTimer);
    // If Claude never confirms, stop the process; the turn then ends as cancelled.
    this.interruptTimer = setTimeout(() => {
      void this.close().then(() => this.finishTurn({ type: "turn-cancelled" }));
    }, this.interruptGraceMs);
    this.permissions.cancelAll();
    this.questions.cancelAll();
    // interrupt() rejects with "Query closed before response received" when the query
    // closes first; that is expected during cancel and shutdown.
    await this.query?.interrupt().catch(() => {});
  }

  async close() {
    settleSubagents(this.state, "cancelled").forEach((event) => this.emit(event));
    this.permissions.cancelAll();
    this.questions.cancelAll();
    if (this.turnActive) this.cancelRequested = true;
    this.closed = true;
    this.inbox?.end();
    const query = this.query;
    this.query = null;
    // An async generator stuck on an await never settles return(), so don't wait forever.
    await Promise.race([query?.return?.().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1000))]);
    await killTree(this.child);
    this.finishTurn({ type: "turn-cancelled" });
  }
}

module.exports = { ClaudeSession, CLAUDE_MODES };
