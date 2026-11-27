const { spawnCommand } = require("./command.cjs");
const { readMcpExtras } = require("../mcp/extras.cjs");
const { settleSubagents } = require("./subagents.cjs");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { killTree } = require("./process-tree.cjs");
const { bundledAgents } = require("../bundled-skills.cjs");
const {
  sessionInstructions,
  SUBAGENT_DESIGN_INSTRUCTIONS,
  SUBAGENT_PLAN_INSTRUCTIONS,
  RESUME_FAILED_MESSAGE,
  AUTH_RETRY_MESSAGE,
  crashMessage,
  failedWith,
  isTerminal,
  mapClaudeMessage,
  missingCliMessage,
} = require("./events.cjs");
const { claudeLoggedOut } = require("./status.cjs");
const { claudeRewindPoint, REWIND_REJECTED } = require("./claude-rewind.cjs");
const { PendingPermissions, WorkspaceAccess, claudeAccessRequest, claudeRequest, claudeResult, isUngatedMilagreTool } = require("./permissions.cjs");
const { PendingQuestions, claudeQuestionRequest, claudeQuestionResult } = require("./questions.cjs");
const { mcpContent, runTool } = require("../linked-tools.cjs");
const { advisorPolicy } = require("./advisor-policy.cjs");
const { babysitDenial } = require("../babysit-guard.cjs");
const { commandRisk } = require("./command-risk.cjs");
const { ONLY_READS, claudeCall, turnGuards } = require("../escalation-guard.cjs");
const { toClaudeConfig } = require("../mcp/definitions.cjs");
const { promptImageBlocks } = require("@milagre/shared/prompt-parts");

const QA_AGENTS = bundledAgents();

// Milagre permission mode -> Claude Code permission mode. In Ask (`default`) Claude Code checks with
const CLAUDE_MODES = { ask: "default", auto: "acceptEdits", full: "bypassPermissions" };

// Claude Code's built-in terse output style. Unlike text appended to the system prompt, which the SDK
const CONCISE_STYLE = "Concise";

// Claude Code prints this when --resume names a session it no longer has.
const MISSING_CONVERSATION = /No conversation found/i;

function promptSuggestionsEnabled(directory, env) {
  if (env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION === "false") return false;
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8"))?.promptSuggestionEnabled !== false;
  } catch {
    return true;
  }
}

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

function userMessage(prompt, images = []) {
  const content = promptImageBlocks(prompt, images).map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image", source: { type: "base64", media_type: block.image.mime, data: block.image.base64 } },
  );
  return { type: "user", uuid: randomUUID(), message: { role: "user", content }, parent_tool_use_id: null };
}

function sdkTool(sdk, definition, name) {
  return sdk.tool(
    name,
    definition.description,
    definition.input,
    async (args) => {
      const result = await runTool(definition, args);
      return { content: mcpContent(result), isError: result.isError };
    },
    { annotations: { readOnlyHint: definition.readOnly } },
  );
}

// permission mode, as on Codex and Antigravity (isUngatedMilagreTool).
function linkedOptions(tools, sdk) {
  const own = tools.filter((definition) => !definition.connector);
  const connectors = tools.filter((definition) => definition.connector);
  const mcpServers = {
    milagre: sdk.createSdkMcpServer({ name: "milagre", alwaysLoad: true, tools: own.map((definition) => sdkTool(sdk, definition, definition.name)) }),
  };
  for (const [id, group] of Map.groupBy(connectors, (definition) => definition.connector))
    mcpServers[id] = sdk.createSdkMcpServer({ name: id, tools: group.map((definition) => sdkTool(sdk, definition, definition.serverToolName)) });
  return {
    mcpServers,
    allowedTools: [
      ...own.filter(isUngatedMilagreTool).map((definition) => `mcp__milagre__${definition.name}`),
      ...connectors.filter((definition) => definition.readOnly === true).map((definition) => `mcp__${definition.connector}__${definition.serverToolName}`),
    ],
  };
}

const sessionClosedError = () => Object.assign(new Error("The agent session closed before this message was sent."), { sessionClosed: true });

class ClaudeSession {
  constructor({
    cwd,
    resumeId,
    command,
    env,
    defaultConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    emit,
    workspaceRoots,
    readOnlyRoots,
    access = new WorkspaceAccess({ cwd, workspaceRoots, readOnlyRoots }),
    workspaceInstructions,
    tldrEnabled = true,
    sharedLink = false,
    analysisOnly = false,
    sideChat = false,
    forkSession = false,
    ephemeral = false,
    executionAdvisor = false,
    linked = null,
    mcpExtras = null,
    loadSdk = () => import("@anthropic-ai/claude-agent-sdk"),
    spawnImpl = spawn,
    interruptGraceMs = 3000,
    loggedOut = (command, env) => claudeLoggedOut(command, { env }),
  }) {
    Object.assign(this, {
      cwd,
      resumeId,
      command,
      env,
      defaultConfigDir,
      emit,
      access,
      workspaceInstructions,
      tldrEnabled,
      sharedLink,
      analysisOnly,
      sideChat,
      forkSession,
      ephemeral,
      executionAdvisor,
      linked,
      mcpExtras,
      loadSdk,
      spawnImpl,
      interruptGraceMs,
      loggedOut,
    });
    this.state = { sessionId: forkSession ? null : (resumeId ?? null), turnId: null, hasText: false };
    this.query = null;
    this.inbox = null;
    this.child = null;
    this.stderr = "";
    this.turnActive = false;
    this.cancelRequested = false;
    this.closed = false;
    this.permissions = new PendingPermissions((event) => this.emit(event));
    this.guard = null;
    this.escalation = null;
    this.questions = new PendingQuestions((event) => this.emit(event));
    // Settles once the running turn's own message is in Claude Code's input (or the turn failed to start).
    this.turnReady = Promise.resolve();
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
    Object.assign(
      this,
      turnGuards(request.guard, () => void this.interrupt()),
    );
    this.implicitTurn = false;
    this.steeredTurn = false;
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

  async beginTurn({ prompt, images = [], model, permissionMode, effort, ultracode = false, fastMode = false, replies, canStart, rewind }) {
    const turnId = randomUUID();
    Object.assign(this.state, { turnId, hasText: false, suggestionTurnId: null, localCommandError: null });
    this.permissions.setMode(permissionMode);
    try {
      if (!this.query) await this.start(model, this.nativeMode(permissionMode), effort, ultracode, fastMode, rewind);
      if (!this.closed) {
        if (model !== this.model) {
          await this.query.setModel(model);
          this.model = model;
        }
        // The user may have switched modes while Claude Code was starting.
        const mode = this.nativeMode(this.permissions.mode);
        if (mode !== this.mode) {
          await this.query.setPermissionMode(mode);
          this.mode = mode;
        }
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
      this.finishTurn({ type: "turn-failed", message: error.message, ...(error.rewindFailed ? { rewindFailed: true } : {}) });
      return { turnId: null, steered: false };
    }
    // close() or interrupt() may have landed while the SDK was loading or the query starting.
    if (this.closed) {
      await this.close();
      this.finishTurn({ type: "turn-cancelled" });
      return { turnId: null, steered: false };
    }
    if (canStart && !canStart()) {
      this.finishTurn(null);
      return { turnId: null, steered: false, cancelled: true };
    }
    if (this.cancelRequested) {
      this.finishTurn({ type: "turn-cancelled" });
      return { turnId: null, steered: false, cancelled: true };
    }
    const message = userMessage(prompt, images);
    this.inbox.push(message);
    this.emit({ type: "turn-started", turnId });
    return { turnId, steered: false, promptId: message.uuid };
  }

  // Claude Code's mode for Milagre's. A wake's turn runs in the strictest one that still reads: `permissions` keeps the
  nativeMode(permissionMode) {
    if (this.analysisOnly) return "dontAsk";
    return this.escalation ? "default" : (CLAUDE_MODES[permissionMode] ?? "default");
  }

  // Concise is Claude Code's flag-layer outputStyle; Normal clears it (null), which falls back to the style
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
  async steer(request) {
    await this.turnReady;
    const ended = this.turnEnded;
    if (this.cancelRequested) {
      await ended;
      if (this.closed) throw sessionClosedError();
      return this.startTurn(request);
    }
    if (!this.turnActive || !this.inbox || this.closed) return this.startTurn(request);
    // Claude Code holds a message until the question it waits on is settled. The message is the user's
    this.questions.dismissAll();
    this.steeredTurn = true;
    if (request.guard) this.guard = request.guard;
    if (request.permissionMode) await this.setPermissionMode(request.permissionMode);
    const message = userMessage(request.prompt, request.images);
    this.inbox.push(message);
    return { turnId: this.state.turnId, steered: true, promptId: message.uuid };
  }

  beginImplicitTurn() {
    const turnId = randomUUID();
    this.turnActive = true;
    this.announcedId = false;
    this.cancelRequested = false;
    Object.assign(this.state, { turnId, hasText: false, localCommandError: null });
    this.turnReady = Promise.resolve();
    this.turnEnded = new Promise((resolve) => {
      this.markEnded = resolve;
    });
    this.emit({ type: "turn-started", turnId, ...(this.lastTurnId ? { continues: this.lastTurnId } : {}) });
  }

  async start(model, mode, effort, ultracode = false, fastMode = false, rewind = null) {
    const at = await this.rewindPoint(rewind);
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
    this.promptSuggestions = !this.analysisOnly && !this.executionAdvisor && promptSuggestionsEnabled(this.defaultConfigDir, this.env ?? process.env);
    // Claude Code takes every owned root as its own directory; one made later reaches it through askPermission.
    this.access.learned();
    // Settings › MCP: Everywhere servers join the Chat's servers; off servers are switched off once Claude Code has started.
    const extras = this.mcpExtras && !this.analysisOnly ? await readMcpExtras(this) : null;
    if (this.closed) return;
    this.mcpOff = extras?.off ?? [];
    const linked = this.linked?.tools.length ? linkedOptions(this.linked.tools, sdk) : {};
    const extraServers = Object.fromEntries((extras?.servers ?? []).map((def) => [def.name, toClaudeConfig(def)]));
    const hooks = {};
    if (!this.analysisOnly && !this.executionAdvisor)
      hooks.SubagentStart = [
        {
          hooks: [
            async () => ({
              hookSpecificOutput: {
                hookEventName: "SubagentStart",
                additionalContext: [
                  SUBAGENT_PLAN_INSTRUCTIONS,
                  this.linked?.tools.some((tool) => tool.name === "design_show") ? SUBAGENT_DESIGN_INSTRUCTIONS : "",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            }),
          ],
        },
      ];
    if (!this.analysisOnly) hooks.PreToolUse = [{ hooks: [(input) => this.guardHook(input) ?? {}] }];
    this.query = sdk.query({
      prompt: this.inbox,
      options: {
        // Headless Claude Code hides TaskCreate / TaskUpdate / TaskList. Subagents keep their to-do lists in them (the
        env: { ...(this.env ?? process.env), CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" },
        cwd: this.cwd,
        ...(this.access.roots ? { additionalDirectories: this.access.roots.filter((root) => root !== this.cwd) } : {}),
        model,
        permissionMode: mode,
        ...(effort ? { effort } : {}),
        settings: { fastMode, ...(ultracode ? { ultracode: true } : {}) },
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        forwardSubagentText: true,
        promptSuggestions: this.promptSuggestions,
        pathToClaudeCodeExecutable: this.command,
        settingSources: ["user", "project", "local"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: sessionInstructions(this),
        },
        ...linked,
        ...(Object.keys(extraServers).length ? { mcpServers: { ...extraServers, ...linked.mcpServers } } : {}),
        ...(Object.keys(hooks).length ? { hooks } : {}),
        ...(!this.analysisOnly && !this.executionAdvisor ? { agents: QA_AGENTS } : {}),
        canUseTool: (toolName, input, options) =>
          toolName === "AskUserQuestion" ? this.askQuestion(input, options) : this.askPermission(toolName, input, options),
        ...(this.ephemeral ? { persistSession: false } : {}),
        ...(this.analysisOnly ? advisorPolicy("claude", this.linked?.tools ?? []) : {}),
        ...(this.executionAdvisor ? { disallowedTools: ["AskUserQuestion", "Agent", "Task"] } : {}),
        ...this.resumeOptions(at, rewind),
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
    this.forkSession = false;
    void this.readMessages(this.query);
    for (const name of this.mcpOff) await this.query.toggleMcpServer?.(name, false)?.catch(() => {});
    await this.query.setMaxThinkingTokens?.(null, "summarized").catch(() => {});
  }

  resumeOptions(at, rewind) {
    if (!this.resumeId) return {};
    if (at) return { resume: this.resumeId, resumeSessionAt: at, forkSession: true, ...(rewind.dropsTurn ? { resumeDropsTurn: rewind.prompt } : {}) };
    return { resume: this.resumeId, ...(this.forkSession ? { forkSession: true } : {}) };
  }

  // Editing an earlier message resumes a fork of the session that ends just before that message's prompt.
  async rewindPoint(rewind) {
    if (!rewind || !this.resumeId) return null;
    const at = await claudeRewindPoint({
      sessionId: this.resumeId,
      prompt: rewind.prompt,
      env: { ...(this.env ?? process.env), CLAUDE_CONFIG_DIR: this.env?.CLAUDE_CONFIG_DIR || this.defaultConfigDir },
    }).catch(() => null);
    if (!at) throw Object.assign(new Error("Claude Code's session doesn't reach the edited message."), { rewindFailed: true });
    this.state.sessionId = null;
    return at;
  }

  // A babysit Run: Claude Code runs PreToolUse hooks before its permission rules, and a hook's "deny" holds even in
  guardHook(input) {
    const reason = this.escalation ? this.escalationDenial(input) : this.babysitReason(input);
    if (!reason) return undefined;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  }

  babysitReason(input) {
    const command = input.tool_input?.command;
    return this.guard && typeof command === "string" ? babysitDenial(command, this.guard) : null;
  }

  escalationDenial(input) {
    this.escalation.called();
    return this.escalation.denial(claudeCall(input.tool_name, input.tool_input, this.linked?.tools));
  }

  // Claude Code waits on this promise until the user answers in Milagre, the turn stops, or the SDK
  askPermission(toolName, input, options = {}) {
    if (!this.turnActive || this.cancelRequested || this.closed) return Promise.resolve(claudeResult("cancelled", input));
    if (this.escalation) return Promise.resolve({ behavior: "deny", message: ONLY_READS });
    const request = claudeRequest(toolName, input, options);
    // The hook refused it already; this covers a Claude Code that skipped the hook.
    const refused = this.guard && request.kind === "command" ? babysitDenial(request.command, this.guard) : null;
    if (refused) return Promise.resolve({ behavior: "deny", message: refused });
    const decided = this.access.answer(claudeAccessRequest(toolName, input, request), this.permissions.mode);
    if (decided?.decision === "deny") return Promise.resolve({ behavior: "deny", message: decided.message });
    if (decided) {
      this.access.learned(decided.learn);
      const added = decided.learn.length ? { updatedPermissions: [{ type: "addDirectories", directories: decided.learn, destination: "session" }] } : {};
      return Promise.resolve({ behavior: "allow", updatedInput: input, ...added });
    }
    const risk =
      request.kind === "command" && !options.blockedPath
        ? commandRisk(request.command, { cwd: this.access.cwd, roots: [this.access.cwd, ...(this.access.roots ?? [])] })
        : undefined;
    if (this.permissions.mode === "auto" && risk !== undefined) {
      if (!risk) return Promise.resolve({ behavior: "allow", updatedInput: input });
      request.reason = `${risk[0].toUpperCase()}${risk.slice(1)}.`;
    }
    return new Promise((resolve) => {
      const abort = () => this.permissions.resolve(request.requestId, "cancelled");
      const inWorkspace = !options.blockedPath && this.access.contains(request.files ?? []);
      this.permissions.add(
        request,
        (decision) => {
          options.signal?.removeEventListener("abort", abort);
          resolve(claudeResult(decision, input, options.suggestions));
        },
        { inWorkspace, safeCommand: risk === null },
      );
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  respondToPermission(requestId, decision) {
    return this.permissions.resolve(requestId, decision);
  }

  // AskUserQuestion reaches canUseTool in every mode, Full included. Claude Code waits on this promise
  // the SDK aborts the request.
  askQuestion(input, options = {}) {
    if (this.executionAdvisor)
      return Promise.resolve({ behavior: "deny", message: "Report questions or blockers to the parent Chat; execution agents cannot ask the human." });
    if (!this.turnActive || this.cancelRequested || this.closed) return Promise.resolve(claudeQuestionResult("cancelled", input));
    if (this.escalation) return Promise.resolve({ behavior: "deny", message: ONLY_READS });
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
  async setPermissionMode(permissionMode) {
    if (this.analysisOnly) return;
    this.permissions.setMode(permissionMode);
    const mode = this.nativeMode(permissionMode);
    if (!this.query || this.closed || mode === this.mode) return;
    this.mode = mode;
    try {
      await this.query.setPermissionMode(mode);
    } catch {
      this.mode = null;
    }
  }

  /**
   * The end of a background command's output (the last 8 KiB), the tail Claude Code's own /tasks view reads. Only a
   * shell or Monitor task has one; the CLI refuses any other id.
   */
  async taskOutput(taskId) {
    if (!this.query || this.closed) throw new Error("That background task has ended.");
    const { output, total_bytes: totalBytes, truncated } = await this.query.getTaskOutput(taskId);
    return { output: typeof output === "string" ? output : "", totalBytes: Number(totalBytes) || 0, truncated: Boolean(truncated) };
  }

  async readMessages(query) {
    try {
      for await (const message of query) {
        if (message.type === "prompt_suggestion") {
          if (this.promptSuggestions && !this.closed && !this.turnActive && !this.cancelRequested && !this.implicitTurn)
            for (const event of mapClaudeMessage(message, this.state)) this.emit(event);
          continue;
        }
        // Claude Code opens every turn with init. One arriving while no turn runs is a turn Claude Code
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
          else if (!this.endsResume(event, message)) {
            // A logged-out Claude Code keeps answering "not logged in" until it is restarted, so the session
            const ended = event.login && !(await this.loggedOut(this.command, this.env ?? process.env)) ? { ...event, message: AUTH_RETRY_MESSAGE } : event;
            if (ended.login && this.announcedId) this.emit({ type: "session-reset" });
            this.finishTurn(ended);
            if (ended.login) void this.close();
          }
        }
        if (message.type === "result") this.implicitTurn = false;
      }
      this.handleEnd(query, null);
    } catch (error) {
      this.handleEnd(query, error);
    }
  }

  // A resume Claude Code couldn't do: a session it no longer has, or a rewind it refused (never retried).
  endsResume(event, message) {
    if (event.type !== "turn-failed") return false;
    const text = `${event.message}\n${message.errors ?? ""}\n${message.result ?? ""}`;
    if (this.resumeGone(text)) this.resumeFailed();
    else if (text.includes(REWIND_REJECTED)) {
      this.finishTurn({ ...event, rewindFailed: true });
      void this.close();
    } else return false;
    return true;
  }

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
    else if (`${error?.message ?? ""}\n${this.stderr}`.includes(REWIND_REJECTED))
      this.finishTurn({ type: "turn-failed", message: error?.message || REWIND_REJECTED, rewindFailed: true });
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
    this.state.suggestionTurnId = event?.type === "turn-completed" && !this.steeredTurn ? this.state.turnId : null;
    this.turnActive = false;
    this.escalation = null;
    this.lastTurnId = this.state.turnId;
    const markEnded = this.markEnded;
    clearTimeout(this.interruptTimer);
    this.permissions.cancelAll();
    this.questions.cancelAll();
    this.state.tools?.clear();
    this.state.foregroundChildren?.clear();
    this.state.thinking = null;
    if (event) this.emit(event);
    markEnded();
  }

  /** Whether this session stops one subagent on its own; a child can still be waiting for its SDK task ID. */
  stopsSubagents() {
    return typeof this.query?.stopTask === "function";
  }

  canStopSubagent(id) {
    return Boolean(this.query?.stopTask && [...(this.state.taskAgents ?? [])].some(([, agent]) => agent === id));
  }

  async stopSubagent(id) {
    const task = [...(this.state.taskAgents ?? [])].find(([, agent]) => agent === id)?.[0];
    if (!task || !this.query?.stopTask) throw new Error("Stopping this subagent is not available.");
    await this.query.stopTask(task);
  }

  async interrupt() {
    if (!this.turnActive) return;
    this.cancelRequested = true;
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      void this.close().then(() => this.finishTurn({ type: "turn-cancelled" }));
    }, this.interruptGraceMs);
    this.permissions.cancelAll();
    this.questions.cancelAll();
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
    await Promise.race([query?.return?.().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1000))]);
    await killTree(this.child);
    this.finishTurn({ type: "turn-cancelled" });
  }
}

module.exports = { ClaudeSession, CLAUDE_MODES };
