const os = require("node:os");
const { slugify } = require("./worktrees.cjs");
const { agentEnvironment } = require("./agents/command.cjs");

const NAMING_INSTRUCTIONS = [
  "You name git branches. You are shown a task someone gave a coding agent. Do not do the task, answer it, or comment on it.",
  "Reply with only the branch name: 2 to 4 lowercase English words joined by hyphens that say what the change is, such as fix-login-redirect or sidebar-usage-bar.",
  "No prefix, quotes, punctuation or explanation.",
].join(" ");

// Anything but a bare name (a sentence, a refusal, a question back) is not used.
const BARE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;

function branchName(reply) {
  const name = String(reply ?? "")
    .trim()
    .replace(/^[`"']+|[`"'.]+$/g, "")
    .toLowerCase();
  return BARE_NAME.test(name) ? name : "";
}

// A new chat's worktree is named for what it will do, by a one-shot Haiku call that sees only the
// message. Without the Claude CLI, or when the call fails or runs past timeoutMs, the name is the
// message's first words.
async function suggestWorktreeName(
  prompt,
  { command, env, loadSdk = () => import("@anthropic-ai/claude-agent-sdk"), timeoutMs = 6000, instructions = "" } = {},
) {
  const fallback = slugify(prompt);
  if (!command || !fallback) return fallback;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const { query } = await loadSdk();
    const run = query({
      prompt: `<task>\n${prompt.slice(0, 4000)}\n</task>\n\nBranch name for this task:`,
      options: {
        model: "haiku",
        systemPrompt: [
          NAMING_INSTRUCTIONS,
          instructions ? `Project naming guidance (return only the slug; Milagre applies the branch template):\n${instructions}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        tools: [],
        maxTurns: 1,
        // No hooks, CLAUDE.md or saved transcript for a call the user never sees.
        settingSources: [],
        persistSession: false,
        cwd: os.tmpdir(),
        pathToClaudeCodeExecutable: command,
        env: agentEnvironment(env),
        abortController,
      },
    });
    for await (const message of run) {
      if (message.type === "result") return (message.subtype === "success" && branchName(message.result)) || fallback;
    }
  } catch {
    // Signed out, offline or too slow: the message's own words still make a name.
  } finally {
    clearTimeout(timer);
  }
  return fallback;
}

module.exports = { suggestWorktreeName };
