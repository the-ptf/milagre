const path = require("node:path");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { validationAgentNote, validationStaleText } = require("@milagre/shared/validation");
const { createValidations } = require("../validation.cjs");

const ASK_REASON = "Ask mode: runs only when you press Run";
const report = (context) => {
  const text = validationAgentNote(context).replace(/<\/?milagre_note>/g, "");
  return context.stale ? `${text}\n${validationStaleText(context.stale)}.` : text;
};

/**
 * Settings › Project › Validation, the Chat's validation commands and the agent tools. A run after a task follows the
 * Chat's permission mode; the user's Run is its own approval, and the provider gates validation_run like any tool.
 */
function registerValidation({ commands, chats, scopeStates, projectSettings, git, dataDir, knownFolder, tell }) {
  const validations = createValidations({ directory: path.join(dataDir, "validations"), settings: projectSettings, states: scopeStates, chats, git, tell });
  const warn = (what) => (error) => console.warn(`Milagre couldn't ${what}:`, error.message);
  void validations.recover().catch(warn("settle validation runs a stopped host left"));

  commands.handle("project-validation:read", async (_event, projectPath) => {
    await knownFolder(projectPath);
    return projectSettings().getValidation(projectPath);
  });
  commands.handle("project-validation:save", async (_event, projectPath, value) => {
    await knownFolder(projectPath);
    return projectSettings().setValidation(projectPath, value);
  });
  commands.handle("validation:run", async (_event, request = {}) => {
    const { runId } = await validations.start(request.chatId, { trigger: "user" });
    return { runId };
  });
  commands.handle("validation:stop", (_event, request = {}) => validations.stop(request.chatId, request.runId));
  commands.handle("validation:log", (_event, request = {}) => validations.log(request.chatId, request.runId, request.index));

  /** After a turn: marks earlier runs out of date, then validates a completed task that changed files. */
  async function afterTurn(chatId, event, changed) {
    await validations.recheckChat(chatId, { force: true });
    if (event.type !== "turn-completed" || !changed || isLinkScopeKey(projectOfKey(chatId))) return;
    const projectPath = projectOfKey(chatId);
    const { commands: list, afterTask } = await projectSettings().getValidation(projectPath);
    if (!afterTask || !list.length) return;
    const state = await scopeStates.get(projectPath);
    const mode = state.sessions[sessionIdFromKey(chatId)]?.permissionMode ?? chats.turns?.get(chatId)?.permissionMode;
    if (mode === "ask") await validations.notRun(chatId, { trigger: "task", reason: ASK_REASON });
    else await validations.start(chatId, { trigger: "task" });
  }

  function tools(chatId) {
    if (isLinkScopeKey(projectOfKey(chatId) ?? "")) return [];
    return [
      {
        name: "validation_run",
        description:
          "Run this Project's validation commands (Settings › Project › Validation) in this Chat's Worktree and wait for the results: each command's status, exit code and the end of its output. Milagre runs them and records the result in the Chat; your own runs of the same commands don't count as validation. Fails when the Project has none.",
        input: {},
        readOnly: false,
        run: async () => report(await (await validations.start(chatId, { trigger: "agent" })).done),
      },
      {
        name: "validation_status",
        description: "The latest validation result recorded in this Chat, and whether files changed after it ran.",
        input: {},
        readOnly: true,
        run: async () => {
          await validations.recheckChat(chatId, { force: true });
          const latest = await validations.latest(chatId);
          return latest ? report(latest) : "No validation has run in this Chat.";
        },
      },
    ];
  }

  return {
    validations,
    tools,
    afterTurn: (chatId, event, changed) => afterTurn(chatId, event, changed).catch(warn("validate a finished task")),
    chatOpened: (chatId) => void validations.recheckChat(chatId).catch(warn("check a validation result")),
  };
}

module.exports = { registerValidation };
