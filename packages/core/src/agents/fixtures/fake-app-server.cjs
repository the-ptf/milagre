// Stand-in for `codex app-server` in tests. It speaks the JSON-RPC subset Milagre uses.
// FAKE_SCENARIO picks how a turn behaves: reply (default), fail, slow, crash, approval (command
// approval), file-approval, permissions (extra sandbox permissions), withdrawn (an approval Codex
// takes back), steer (the first turn waits; turn/steer joins it, or is refused when its text says
// "too late"), no-turn-id (the first turn is never given an id and ends on its own), stubborn (turn never ends, interrupt unanswered), hang-init (initialize unanswered),
// resume-exit (exits on thread/resume), slow-stop (the first turn takes 150ms to stop after an interrupt),
// late-approval (like slow-stop, and Codex asks for a command approval while the turn is stopping),
// reject-config (thread/start and thread/resume fail with an RPC error when they carry `config`),
// question (Codex asks a question and ends the turn on the answer), question-steer (Codex asks a question
// and the turn waits for turn/steer), question-withdrawn (a question Codex takes back), late-question
// (like late-approval, with a question).
// steps (a command with streamed output and a new file, then a reply), running-step (a command
// starts and the turn waits until it's interrupted).
// fake/turn-started makes it announce a turn nobody asked for.
const fs = require("node:fs");
const { createInterface } = require("node:readline");

const scenario = process.env.FAKE_SCENARIO || "reply";
const received = [];
let threadStarts = 0;
let pendingTurn = null;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const completeTurn = (threadId, turnId, status, error = null) => notify("turn/completed", { threadId, turn: { id: turnId, items: [], status, error } });

const QUESTIONS = [
  {
    id: "color",
    header: "Color",
    question: "Which color?",
    isOther: true,
    isSecret: false,
    options: [
      { label: "Red", description: "Warm" },
      { label: "Green", description: "Calm" },
    ],
  },
];
const askQuestion = (id, threadId, turnId) =>
  send({
    id,
    method: "item/tool/requestUserInput",
    params: { threadId, turnId, itemId: "call-1", questions: QUESTIONS, isBlocking: false, autoResolutionMs: null },
  });

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  received.push(message);
  const { id, method, params = {} } = message;
  if (method === undefined) {
    if (pendingTurn && pendingTurn.approvalId === id) {
      const result = message.result || {};
      const answer = result.decision !== undefined ? `decision:${result.decision}` : `answer:${JSON.stringify(message.result ?? message.error)}`;
      notify("item/agentMessage/delta", { threadId: pendingTurn.threadId, turnId: pendingTurn.turnId, itemId: "msg-1", delta: answer });
      completeTurn(pendingTurn.threadId, pendingTurn.turnId, "completed");
      pendingTurn = null;
    }
    return;
  }
  switch (method) {
    case "initialize":
      if (scenario === "hang-init") return undefined;
      return send({ id, result: { userAgent: "fake/0.158.0" } });
    case "initialized":
      return undefined;
    case "config/read":
      return send({ id, result: { config: { mcp_servers: { personal: { command: "outside-tools" } } } } });
    // logged-out: no login while OpenAI auth is required; custom-provider: a provider that needs no OpenAI login.
    case "account/read":
      if (scenario === "logged-out") return send({ id, result: { account: null, requiresOpenaiAuth: true } });
      if (scenario === "custom-provider" || scenario === "unauthorized-custom") return send({ id, result: { account: null, requiresOpenaiAuth: false } });
      return send({ id, result: { account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true } });
    // Two pages, the second with a hidden model, as model/list pages with nextCursor.
    case "model/list":
      if (!params.cursor)
        return send({
          id,
          result: {
            data: [
              {
                id: "gpt-6-astra",
                displayName: "GPT-6-Astra",
                description: "Frontier intelligence.",
                hidden: false,
                isDefault: true,
                supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }],
                defaultReasoningEffort: "medium",
                serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
              },
            ],
            nextCursor: "page-2",
          },
        });
      return send({
        id,
        result: {
          data: [
            {
              id: "gpt-6-luna",
              displayName: "GPT-6-Luna",
              description: "Fast.",
              hidden: false,
              isDefault: false,
              supportedReasoningEfforts: [{ reasoningEffort: "low" }],
              defaultReasoningEffort: "low",
            },
            {
              id: "codex-auto-review",
              displayName: "Codex Auto Review",
              description: "Review model.",
              hidden: true,
              isDefault: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "medium",
            },
          ],
          nextCursor: null,
        },
      });
    case "fake/received":
      return send({ id, result: { received, threadStarts } });
    case "thread/start":
      if (scenario === "reject-config" && params.config) return send({ id, error: { code: -32602, message: "invalid params: config" } });
      threadStarts += 1;
      return send({ id, result: { thread: { id: `thread-${threadStarts}` }, model: params.model } });
    case "thread/resume":
      if (scenario === "reject-config" && params.config) return send({ id, error: { code: -32602, message: "invalid params: config" } });
      if (scenario === "resume-exit") {
        process.stderr.write("resume exploded\n");
        process.exit(4);
      }
      if (params.threadId === "missing") return send({ id, error: { code: -32600, message: "no rollout found for thread id missing" } });
      return send({ id, result: { thread: { id: params.threadId }, model: params.model } });
    case "thread/unarchive":
      return send({ id, error: { code: -32600, message: "thread is not archived" } });
    case "turn/start": {
      const { threadId } = params;
      const turnId = `turn-${received.filter((item) => item.method === "turn/start").length}`;
      message.imagesExist = (params.input || []).filter((input) => input.type === "localImage").map((input) => fs.existsSync(input.path));
      if (scenario === "no-turn-id" && turnId === "turn-1") {
        send({ id, result: { turn: { items: [], status: "inProgress", error: null } } });
        setTimeout(() => completeTurn(threadId, turnId, "completed"), 50);
        return undefined;
      }
      send({ id, result: { turn: { id: turnId, items: [], status: "inProgress", error: null } } });
      notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
      notify("mcpServer/startupStatus/updated", { name: "noise", status: "ready" });
      if (scenario === "crash") {
        process.stderr.write("boom: model unavailable\n");
        process.exit(3);
      }
      if (scenario === "stubborn") return undefined;
      if (scenario === "steer" && turnId === "turn-1") {
        pendingTurn = { threadId, turnId };
        return undefined;
      }
      if ((scenario === "slow-stop" || scenario === "late-approval" || scenario === "late-question") && turnId === "turn-1") {
        pendingTurn = { threadId, turnId };
        return undefined;
      }
      if (scenario === "slow") {
        pendingTurn = { threadId, turnId };
        return undefined;
      }
      if (scenario === "steps" || scenario === "running-step") {
        const command = {
          type: "commandExecution",
          id: "exec-1",
          command: "/bin/zsh -lc 'npm test'",
          cwd: "/repo",
          status: "inProgress",
          commandActions: [{ type: "unknown", command: "npm test" }],
          aggregatedOutput: null,
          exitCode: null,
        };
        notify("item/started", { threadId, turnId, item: command });
        if (scenario === "running-step") {
          pendingTurn = { threadId, turnId };
          return undefined;
        }
        notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: "exec-1", delta: "ok 2\n" });
        notify("item/completed", { threadId, turnId, item: { ...command, status: "completed", aggregatedOutput: "ok 1\nok 2\n", exitCode: 0 } });
        notify("item/started", { threadId, turnId, item: { type: "reasoning", id: "rs-1", summary: [], content: [] } });
        const patch = {
          type: "fileChange",
          id: "exec-2",
          status: "inProgress",
          changes: [{ path: "/repo/notes.txt", kind: { type: "add" }, diff: "hello\n" }],
        };
        notify("item/started", { threadId, turnId, item: patch });
        notify("item/completed", { threadId, turnId, item: { ...patch, status: "completed" } });
        notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg-1", delta: "Done" });
        return completeTurn(threadId, turnId, "completed");
      }
      if (scenario === "approval") {
        pendingTurn = { threadId, turnId, approvalId: "srv-1" };
        return send({
          id: "srv-1",
          method: "item/commandExecution/requestApproval",
          params: { threadId, turnId, itemId: "cmd-1", startedAtMs: 0, command: "/bin/zsh -lc 'rm -rf build'", cwd: "/repo", reason: "Clean the build" },
        });
      }
      if (["mcp-approval", "mcp-form"].includes(scenario)) {
        pendingTurn = { threadId, turnId, approvalId: "srv-mcp" };
        return send({
          id: "srv-mcp",
          method: "mcpServer/elicitation/request",
          params: {
            threadId,
            turnId,
            serverName: "milagre",
            mode: "form",
            message: 'Allow the milagre MCP server to run tool "design_show"?',
            requestedSchema: { type: "object", properties: scenario === "mcp-form" ? { email: { type: "string" } } : {} },
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              persist: ["session", "always"],
              tool_description: "Create an editable design",
              tool_params: { id: "daily-notes" },
            },
          },
        });
      }
      if (scenario === "file-approval") {
        pendingTurn = { threadId, turnId, approvalId: "srv-1" };
        notify("item/started", {
          threadId,
          turnId,
          item: { type: "fileChange", id: "patch-1", status: "inProgress", changes: [{ path: "/repo/notes.txt", kind: { type: "add" }, diff: "hello\n" }] },
        });
        return send({
          id: "srv-1",
          method: "item/fileChange/requestApproval",
          params: { threadId, turnId, itemId: "patch-1", startedAtMs: 0, reason: "Write notes" },
        });
      }
      if (scenario === "question") {
        pendingTurn = { threadId, turnId, approvalId: "srv-q" };
        return askQuestion("srv-q", threadId, turnId);
      }
      if (scenario === "question-steer") {
        pendingTurn = { threadId, turnId };
        return askQuestion("srv-q", threadId, turnId);
      }
      if (scenario === "question-withdrawn") {
        askQuestion("srv-q", threadId, turnId);
        notify("serverRequest/resolved", { threadId, requestId: "srv-q" });
        return completeTurn(threadId, turnId, "completed");
      }
      if (scenario === "permissions") {
        pendingTurn = { threadId, turnId, approvalId: "srv-1" };
        return send({ id: "srv-1", method: "item/permissions/requestApproval", params: { threadId, turnId, itemId: "perm-1" } });
      }
      if (scenario === "withdrawn") {
        send({
          id: "srv-1",
          method: "item/commandExecution/requestApproval",
          params: { threadId, turnId, itemId: "cmd-1", startedAtMs: 0, command: "/bin/zsh -lc 'ls'" },
        });
        notify("serverRequest/resolved", { threadId, requestId: "srv-1" });
        return completeTurn(threadId, turnId, "completed");
      }
      notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg-1", delta: "Hel" });
      notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg-1", delta: "lo" });
      if (scenario === "fail") return completeTurn(threadId, turnId, "failed", { message: "The model gpt-x is not supported." });
      // unauthorized: logged in as far as account/read knows, but the API answers 401 (an expired token).
      // unauthorized-custom: the same on a provider that needs no OpenAI login.
      if (scenario === "unauthorized" || scenario === "unauthorized-custom")
        return completeTurn(threadId, turnId, "failed", {
          message: "unexpected status 401 Unauthorized: token expired",
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
        });
      return completeTurn(threadId, turnId, "completed");
    }
    case "fake/turn-started":
      notify("turn/started", { threadId: "thread-1", turn: { id: "turn-ghost", status: "inProgress" } });
      return send({ id, result: {} });
    case "turn/interrupt":
      if (scenario === "stubborn") return undefined;
      if (scenario === "slow-stop" || scenario === "late-approval" || scenario === "late-question") {
        const stopping = pendingTurn;
        pendingTurn = null;
        setTimeout(() => {
          send({ id, result: {} });
          if (scenario === "late-approval")
            send({
              id: "srv-late",
              method: "item/commandExecution/requestApproval",
              params: { threadId: stopping.threadId, turnId: stopping.turnId, itemId: "cmd-late", startedAtMs: 0, command: "/bin/zsh -lc 'ls'" },
            });
          if (scenario === "late-question") askQuestion("srv-late", stopping.threadId, stopping.turnId);
          completeTurn(stopping.threadId, stopping.turnId, "interrupted");
        }, 150);
        return undefined;
      }
      send({ id, result: {} });
      if (pendingTurn) {
        completeTurn(pendingTurn.threadId, pendingTurn.turnId, "interrupted");
        pendingTurn = null;
      }
      return undefined;
    case "turn/steer": {
      const text = (params.input || []).map((input) => input.text || "").join("");
      if (!pendingTurn || params.expectedTurnId !== pendingTurn.turnId || text.includes("too late")) {
        send({ id, error: { code: -32600, message: "no active turn to steer" } });
        if (pendingTurn) completeTurn(pendingTurn.threadId, pendingTurn.turnId, "completed");
        pendingTurn = null;
        return undefined;
      }
      send({ id, result: { turnId: pendingTurn.turnId } });
      notify("item/agentMessage/delta", { threadId: pendingTurn.threadId, turnId: pendingTurn.turnId, itemId: "msg-1", delta: `steered:${text}` });
      completeTurn(pendingTurn.threadId, pendingTurn.turnId, "completed");
      pendingTurn = null;
      return undefined;
    }
    default:
      return send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
