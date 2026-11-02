const { isLinkScopeKey, scopeKey } = require("@milagre/shared/chat-scopes");
const fs = require("node:fs/promises");
const path = require("node:path");
const { z } = require("zod");
const { chatTitle } = require("@milagre/shared/chats");
const { isNote } = require("@milagre/shared/chat-summary");
const { providerName } = require("@milagre/shared/providers");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { chatActivity } = require("@milagre/shared/chat-activity");

/** A linked Chat's status, the same activity its sidebar row shows (chat-activity.mjs), with its background work. */
function linkedStatus(session, run) {
  const { activity, background } = chatActivity(session, run);
  return { status: activity, ...(background ? { backgroundWork: background } : {}) };
}
const { NEGOTIATION_ROUNDS } = require("@milagre/shared/limits");
const { createGit } = require("./git/client.cjs");
const { buildLinkedSummary } = require("./linked-summary.cjs");

const git = createGit({ analysisOnly: true }).read;
const MAX_OUTPUT = 40_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MESSAGES = 30;

// Whether a Chat has messages, from its summary when it has one: an unloaded Chat's aren't in the state.
const hasMessages = (state, session) => (session.summary?.count ?? 0) > 0 || state.messages.some((message) => message.session_id === session.id);

const cap = (text) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… truncated` : text);

function lastReply(state, sessionId) {
  return (state.messages ?? state).findLast(
    (message) => message.session_id === sessionId && message.role === "assistant" && !isNote(message) && message.body?.trim(),
  )?.body;
}

// The text a reply ends with: what follows its last tool step, or the last stretch of text between steps when it ended on
// one. A saved reply holds the whole turn (its narration between tool calls too); step offsets index its body.
function replyEnd(message) {
  const body = message.body ?? "";
  const cuts = [...new Set([0, ...(message.steps ?? []).filter((step) => step.kind !== "thinking").map((step) => step.offset ?? 0)])]
    .filter((cut) => cut >= 0 && cut <= body.length)
    .sort((a, b) => a - b);
  for (let index = cuts.length - 1; index >= 0; index--) {
    const text = body.slice(cuts[index], cuts[index + 1] ?? body.length).trim();
    if (text) return text;
  }
  return body.trim();
}

/**
 * What a Chat's agent ended its reply to a Delegation with (Milagre's own notes left out), or undefined: the text after
 * the last tool step of its last reply, so the narration of the work stays in that Chat and the report is its answer.
 */
function delegationReply(state, sessionId, delegationId) {
  const messages = (state.messages ?? state).filter((message) => message.session_id === sessionId);
  const start = messages.findIndex((message) => message.context?.kind === "delegation" && message.context.delegationId === delegationId);
  if (start === -1) return undefined;
  const last = messages.slice(start + 1).findLast((message) => message.role === "assistant" && message.context === null && message.body?.trim());
  return last ? replyEnd(last) || undefined : undefined;
}

/** "Project / branch / Chat title", how one Chat names another across a Link. */
function chatLabel(projectName, state, sessionId) {
  const session = state.sessions[sessionId];
  if (!session) return `${projectName} / unknown Chat`;
  const worktree = state.worktrees?.[session.worktree_id];
  return `${projectName} / ${worktree?.name ?? "unknown branch"} / ${chatTitle(
    session,
    state.messages.filter((message) => message.session_id === sessionId),
  )}`;
}

// A relative path inside the Worktree: no option-looking arguments, no way out through `..` or a symlink.
async function insideWorktree(worktree, relative) {
  if (typeof relative !== "string" || !relative || relative.startsWith("-") || path.isAbsolute(relative))
    throw new Error("Give a path relative to the linked Worktree.");
  const root = await fs.realpath(worktree);
  const resolved = await fs.realpath(path.resolve(root, relative)).catch(() => path.resolve(root, relative));
  const from = path.relative(root, resolved);
  if (!from || from.startsWith("..") || path.isAbsolute(from)) throw new Error("That path is outside the linked Worktree.");
  return resolved;
}

/**
 * Read access to the Worktrees a Chat can see, and nothing else. `view` supplies:
 *   sides(chatId) -> [{ project_id, worktree_path, link_id, projectPath, projectName }]
 *   state(projectPath) -> the Project's state, which can leave out unloaded Chats' messages (see message-store.cjs)
 *   messages(projectPath, chatIds) -> those Chats' messages, whole; bodies(projectPath, chatIds) -> their ids, roles
 *   and bodies; runs() -> streaming runs by chat key
 *   open(side) -> lines about the open Delegations and Negotiations with that side; receiveOnly(chatKey) -> boolean
 */
function createLinkedReads(view) {
  // A view without the message ports reads them from its states, which then hold every message.
  const messagesOf =
    view.messages ?? (async (projectPath, chatIds) => (await view.state(projectPath)).messages.filter((message) => chatIds.includes(message.session_id)));
  const bodiesOf = view.bodies ?? messagesOf;
  async function side(chatId, worktreePath) {
    const found = (await view.sides(chatId)).find((item) => item.worktree_path === worktreePath);
    if (!found) throw new Error("That Worktree isn't linked to this Chat. Use linked_overview to see the ones that are.");
    return found;
  }

  async function summary(chatId) {
    const runs = view.runs();
    const sides = await Promise.all(
      (await view.sides(chatId)).map(async (item) => {
        const state = await view.state(item.projectPath);
        const worktree = Object.values(state.worktrees).find((entry) => entry.path === item.worktree_path);
        const listed = Object.values(state.sessions).filter((session) => session.worktree_id === worktree?.id && hasMessages(state, session));
        // Ids, roles and bodies are all a summary reads, so an unloaded Chat isn't read whole.
        const all = listed.length
          ? await bodiesOf(
              item.projectPath,
              listed.map((session) => session.id),
            )
          : [];
        const ordinary = listed.map((session) => {
          const ref = `${item.projectPath}#${session.id}`;
          const messages = all.filter((message) => message.session_id === session.id);
          return {
            ref,
            title: chatTitle(session, messages),
            provider: session.provider ? providerName(session.provider) : undefined,
            ...linkedStatus(session, runs[ref]),
            archived: session.archived,
            activity: runs[ref] ? Number.MAX_SAFE_INTEGER : (messages.at(-1)?.id ?? 0),
            lastReply: lastReply(messages, session.id),
            receiveOnly: view.receiveOnly(ref),
          };
        });
        let chats = ordinary;
        if (worktree?.sharedChat) {
          const owner = scopeKey({ kind: "link", linkId: worktree.sharedChat.linkId });
          const shared = await view.state(owner);
          const session = shared.sessions[worktree.sharedChat.sessionId];
          if (session?.worktrees.some((member) => member.worktreePath === item.worktree_path)) {
            const ref = `${owner}#${session.id}`,
              messages = await bodiesOf(owner, [session.id]);
            chats = [
              {
                ref,
                title: chatTitle(session, messages),
                provider: session.provider ? providerName(session.provider) : undefined,
                ...linkedStatus(session, runs[ref]),
                archived: session.archived,
                activity: runs[ref] ? Number.MAX_SAFE_INTEGER : (messages.at(-1)?.id ?? 0),
                lastReply: lastReply(messages, session.id),
                receiveOnly: true,
              },
            ];
          }
        }
        return {
          project: item.projectName,
          worktree: item.worktree_path,
          branch: worktree?.name ?? path.basename(item.worktree_path),
          diff: worktree?.diff,
          chats,
          open: view.open(item),
        };
      }),
    );
    return buildLinkedSummary(sides);
  }

  const overview = async (chatId) => (await summary(chatId)) || "No Worktrees are linked to this Chat.";

  async function readChat(chatId, chat, range = {}) {
    const projectPath = projectOfKey(String(chat));
    const sessionId = sessionIdFromKey(String(chat));
    const visible = await view.sides(chatId);
    let sides, state;
    if (isLinkScopeKey(projectPath)) {
      const id = projectPath.slice("milagre-link:".length);
      sides = [];
      for (const item of visible) {
        const memberState = await view.state(item.projectPath);
        const worktree = Object.values(memberState.worktrees).find((entry) => entry.path === item.worktree_path);
        if (worktree?.sharedChat?.linkId === id && worktree.sharedChat.sessionId === sessionId) sides.push(item);
      }
      if (!sides.length) throw new Error("That Chat isn't in a linked Worktree.");
      state = await view.state(projectPath);
      if (!state.sessions[sessionId]?.worktrees.some((member) => sides.some((side) => side.worktree_path === member.worktreePath)))
        throw new Error("That Chat isn't in a linked Worktree.");
    } else {
      sides = visible.filter((item) => item.projectPath === projectPath);
      if (!sides.length) throw new Error("That Chat isn't in a linked Worktree.");
      state = await view.state(projectPath);
      const session = state.sessions[sessionId],
        worktree = state.worktrees[session?.worktree_id];
      if (!session || !sides.some((item) => item.worktree_path === worktree?.path)) throw new Error("That Chat isn't in a linked Worktree.");
    }
    const session = state.sessions[sessionId];
    const messages = await messagesOf(projectPath, [sessionId]);
    const end = Math.min(messages.length, range.end ?? messages.length);
    const start = Math.max(1, range.start ?? end - DEFAULT_MESSAGES + 1);
    const parts = [
      `# ${chatLabel(sides[0].projectName, state, sessionId)}`,
      `Messages ${start}–${end} of ${messages.length}${session.archived ? " · archived" : ""}`,
    ];
    messages.slice(start - 1, end).forEach((message, index) => {
      const steps = (message.steps ?? [])
        .filter((step) => step.kind !== "thinking")
        .map((step) => `- ${step.title}`)
        .join("\n");
      const from =
        message.context?.kind === "delegation" ? `Delegation from ${message.context.fromLabel}` : message.role === "assistant" ? "Assistant" : "User";
      parts.push(`## ${start + index} · ${from}`, [steps, message.body].filter(Boolean).join("\n\n"));
    });
    return cap(parts.join("\n\n"));
  }

  const GIT_COMMANDS = {
    status: () => ["status", "--short", "--branch"],
    diff: ({ staged, path: file }) => ["diff", "--no-color", ...(staged ? ["--cached"] : []), "--", ...(file ? [file] : [])],
    log: ({ limit, path: file }) => ["log", "--oneline", "--decorate", "-n", String(Math.min(Math.max(limit ?? 20, 1), 200)), "--", ...(file ? [file] : [])],
  };

  async function linkedGit(chatId, worktree, operation, options = {}) {
    const { worktree_path } = await side(chatId, worktree);
    if (!GIT_COMMANDS[operation]) throw new Error("Choose status, diff or log.");
    if (options.path !== undefined) await insideWorktree(worktree_path, options.path);
    const output = await git.text(worktree_path, GIT_COMMANDS[operation](options));
    return cap(output.trim() || `git ${operation}: nothing to show.`);
  }

  async function readFile(chatId, worktree, file, range = {}) {
    const { worktree_path } = await side(chatId, worktree);
    const resolved = await insideWorktree(worktree_path, file);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile()) throw new Error("No such file in the linked Worktree.");
    if (stat.size > MAX_FILE_BYTES) throw new Error("That file is over 2 MB; read part of it with search_linked_files instead.");
    const lines = (await fs.readFile(resolved, "utf8")).split("\n");
    const start = Math.max(1, range.start ?? 1);
    const end = Math.min(lines.length, range.end ?? lines.length);
    return cap(
      lines
        .slice(start - 1, end)
        .map((line, index) => `${start + index}\t${line}`)
        .join("\n"),
    );
  }

  async function search(chatId, worktree, query, glob) {
    const { worktree_path } = await side(chatId, worktree);
    if (typeof query !== "string" || !query) throw new Error("Give some text to search for.");
    if (glob !== undefined && (typeof glob !== "string" || glob.startsWith("-"))) throw new Error("Give a glob such as src/**/*.ts.");
    const result = await git.run(worktree_path, ["grep", "-n", "-I", "--untracked", "-F", "-e", query, "--", ...(glob ? [glob] : [])]);
    if (result.code === 1) return "No matches.";
    if (!result.ok) throw new Error(result.message || "The search failed.");
    const lines = result.stdout.trim().split("\n");
    return cap([...lines.slice(0, 200), ...(lines.length > 200 ? [`… ${lines.length - 200} more matches`] : [])].join("\n"));
  }

  return { summary, overview, readChat, git: linkedGit, readFile, search };
}

// Worktrees and Chats are named exactly as linked_overview shows them.
const worktree = z.string().describe('The linked Worktree\'s absolute path, as linked_overview shows it after "worktree".');
const range = z.object({ start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional() }).optional();

/**
 * The tools a Chat gets for its Links, as provider-neutral definitions: a zod input shape and `run`, which
 * resolves to text. Reads are scoped to the Worktrees the Chat can see; `delegate` and `conclude_negotiation`
 * go to the Delegations (see delegations.cjs). Nothing here writes to a linked Worktree.
 */
function linkedToolDefinitions(chatId, { reads, delegations }) {
  return [
    {
      name: "linked_overview",
      description:
        "Summary of every Worktree linked to this Chat: Project, branch, diff, each Chat's status and last reply, and open Delegations and Negotiations.",
      input: {},
      readOnly: true,
      run: () => reads.overview(chatId),
    },
    {
      name: "read_linked_chat",
      description:
        "Read a linked Chat's transcript, archived Chats included. `chat` is the Chat ref from linked_overview (projectPath#id). `range` picks message numbers; the default is the last 30.",
      input: { chat: z.string().describe("A Chat ref from linked_overview: projectPath#id."), range },
      readOnly: true,
      run: ({ chat, range: span }) => reads.readChat(chatId, chat, span),
    },
    {
      name: "linked_git",
      description:
        "Run a read-only git query in a linked Worktree: status, diff (optionally staged, or for one path) or log (optionally for one path, up to `limit` commits).",
      input: {
        worktree,
        operation: z.enum(["status", "diff", "log"]),
        path: z.string().optional(),
        staged: z.boolean().optional(),
        limit: z.number().int().optional(),
      },
      readOnly: true,
      run: ({ worktree, operation, ...options }) => reads.git(chatId, worktree, operation, options),
    },
    {
      name: "read_linked_file",
      description: "Read a text file in a linked Worktree. `path` is relative to the Worktree; `range` picks line numbers.",
      input: { worktree, path: z.string(), range },
      readOnly: true,
      run: ({ worktree, path: file, range: span }) => reads.readFile(chatId, worktree, file, span),
    },
    {
      name: "search_linked_files",
      description: "Search the files of a linked Worktree for literal text, optionally limited to a glob such as src/**/*.ts. Lists file:line:match.",
      input: { worktree, query: z.string(), glob: z.string().optional() },
      readOnly: true,
      run: ({ worktree, query, glob }) => reads.search(chatId, worktree, query, glob),
    },
    {
      name: "delegate",
      description: `Hand work to another Chat: in a linked Worktree, or in any Worktree of this Chat's own Project (this one included, no Link needed). That Chat's own agent carries it out in the Chat you pick (a Chat ref, or "new"); its Delegation report comes back to this Chat later and reaches you with your next turn, so don't wait for it. Use it instead of chat_start when you want the result back. The message runs in that Chat's own permission mode (a new Chat takes yours); if that is more than yours, the user approves first: the call can wait minutes for that card, so wait for its result, don't end the turn or move on. Set \`negotiation\` when the two sides must agree on something first: each report then starts the other side's next turn, for up to ${NEGOTIATION_ROUNDS} rounds.`,
      input: {
        worktree: z
          .string()
          .describe("The Worktree's absolute path: as linked_overview shows it after \"worktree\", or from worktree_list for this Chat's own Project."),
        chat: z.string().describe('A Chat ref (projectPath#id) in that Worktree, from linked_overview or chat_list, or "new".'),
        message: z.string().min(1),
        negotiation: z.boolean().optional(),
        computer: z
          .string()
          .optional()
          .describe("Another paired computer's name, for a Worktree on it, as linked_overview lists them. Leave out for this computer."),
      },
      readOnly: false,
      run: (args) => delegations.delegate(chatId, args),
    },
    {
      name: "conclude_negotiation",
      description:
        "End the Negotiation this turn belongs to, with a summary of what the two sides agreed. It is posted in both Chats. Only works inside a Negotiation.",
      input: { summary: z.string().min(1) },
      readOnly: false,
      run: ({ summary }) => delegations.conclude(chatId, summary),
    },
  ];
}

const { inputSchema, runTool } = require("./command-dispatcher.cjs");

/** MCP content for a tool result: its text, then any images, which Claude and Codex both read. */
const mcpContent = ({ text, images = [] }) => [{ type: "text", text }, ...images.map((image) => ({ type: "image", data: image.base64, mimeType: image.mime }))];

module.exports = { chatLabel, createLinkedReads, delegationReply, inputSchema, linkedToolDefinitions, mcpContent, runTool };
