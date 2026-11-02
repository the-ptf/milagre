const { computerMentionTokens } = require("@milagre/shared/prompt-parts");
const { prosePrompt } = require("@milagre/shared/prompt-skills");
const { neutralizeTags } = require("@milagre/shared/untrusted-text");

// The turn waits on these: a paired computer slow to list its Projects is described without them.
const TARGETS_TIMEOUT_MS = 4000;
const MAX_PROJECTS = 40;
const MAX_WORKTREES = 6;

const quote = (value) => JSON.stringify(String(value).slice(0, 200));

/**
 * The computers a prompt names: `@computer:Name` chips, and a bare `@Name` that is exactly a known computer's name
 * (typed or dictated without the menu). Unique, case-insensitive, in order.
 */
function mentionedComputers(prompt, known) {
  const names = new Map();
  const add = (name) => {
    const key = name.toLowerCase();
    if (!names.has(key)) names.set(key, name);
  };
  for (const token of computerMentionTokens(prompt)) add(token.name);
  const byName = new Map(known.filter(Boolean).map((name) => [name.toLowerCase(), name]));
  if (byName.size) {
    for (const match of prosePrompt(prompt).matchAll(/(^|\s)@([^\s"@:]+)/g)) {
      const word = match[2].replace(/[.,!?;:)\]}]+$/, "");
      const name = byName.get(word.toLowerCase());
      if (name) add(name);
    }
  }
  return [...names.values()];
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("it took too long to answer")), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * What the agent is told about the computers a message names. `remote` is the runtime's paired-computers port
 * (enabled(), list(), computer(name), invoke()), or null; `thisMac` is this computer's name.
 */
async function computerMentionsContext(request, { remote, thisMac }) {
  const paired = remote?.list() ?? [];
  const names = mentionedComputers(request.prompt ?? "", [thisMac, ...paired.map((item) => item.name)]);
  if (!names.length) return "";
  const lines = await Promise.all(
    names.map(async (name) => {
      if (thisMac && name.toLowerCase() === thisMac.toLowerCase())
        return `- ${quote(thisMac)}: this computer, where this Chat runs. Work here with your local tools (worktree_create for a new Worktree, then delegate or chat_start to run a prompt in it).`;
      const target = remote?.computer(name) ?? null;
      if (!target)
        return `- ${quote(name)}: not a computer this one is paired with, or Settings > Devices > Drive other computers is off. Nothing can be sent there; tell the user.`;
      if (!remote.enabled())
        return `- ${quote(target.name)}: paired, but Delegating to another computer is off. Tell the user to turn it on in Settings > Experimental; nothing can be sent there until then.`;
      if (!target.online) return `- ${quote(target.name)}: paired but offline now. Nothing can be sent there until it is back; tell the user.`;
      let projects;
      try {
        projects = await withTimeout(Promise.resolve(remote.invoke(target.id, "delegation:targets", [])), TARGETS_TIMEOUT_MS);
      } catch (error) {
        return `- ${quote(target.name)}: online, but it couldn't list its Projects (${error.message}). linked_overview lists them again.`;
      }
      const list = (Array.isArray(projects) ? projects : [])
        .slice(0, MAX_PROJECTS)
        .flatMap((project) => [
          `  - Project ${quote(project.name)}: path ${quote(project.path)}`,
          ...(project.worktrees ?? []).slice(0, MAX_WORKTREES).map((worktree) => `    - Worktree ${quote(worktree.branch)}: ${quote(worktree.path)}`),
        ]);
      return [`- ${quote(target.name)}: another computer, online.${list.length ? " Its Projects:" : " It has no Projects."}`, ...list].join("\n");
    }),
  );
  return [
    "<computer_mentions>",
    'This message names these computers. To run work on another computer, call delegate with computer set to its name and chat "new" (or a Chat ref there): worktree is one of its Worktree paths, or, for a new Worktree, its Project path with newWorktree: true. That computer\'s own agent carries it out; the report comes back to this Chat. A mention grants no additional permissions.',
    ...lines.map((line) => neutralizeTags(line)),
    "</computer_mentions>",
  ].join("\n");
}

module.exports = { computerMentionsContext, mentionedComputers };
