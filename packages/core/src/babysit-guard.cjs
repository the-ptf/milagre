// Babysit PRs: what a babysit Run's level lets its agent do on GitHub, enforced on each shell command the agent runs
// (claude-provider, codex-provider, acp-session), whatever its permission mode. The prompt asks; this refuses.
const path = require("node:path");
const { BABYSIT_LEVELS } = require("@milagre/shared/babysit");

const NEVER_MERGES = "Babysitting never merges.";
// A GraphQL body in a file can't be read here (no I/O), so it could hold any mutation; no setting allows it.
const UNREADABLE_GRAPHQL = "Babysitting can't check a GraphQL request read from a file, so it's blocked.";

// What each guarded action is called in the denial, and whether a Run's guard ({ level, resolveThreads }, already the
// Run's effective values) allows it. Merging and unreadable GraphQL are never allowed and have their own reasons.
const ACTIONS = {
  push: { text: "pushing to GitHub", allowed: ({ level }) => level >= 3 },
  reply: { text: "replying on GitHub", allowed: ({ level }) => level >= 4 },
  rerequest: { text: "re-requesting review", allowed: ({ level }) => level >= 5 },
  resolve: { text: "resolving review threads", allowed: ({ level, resolveThreads }) => resolveThreads === true && level >= 4 },
};
const ORDER = ["push", "reply", "rerequest", "resolve"];

// GitHub GraphQL mutations by the action they take.
const MUTATIONS = [
  ["merge", /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/],
  ["push", /\b(?:createCommitOnBranch|updateRefs?|createRef|deleteRef|updatePullRequestBranch)\b/],
  [
    "reply",
    /\b(?:addPullRequestReviewComment|addPullRequestReviewThreadReply|addPullRequestReviewThread|addPullRequestReview|submitPullRequestReview|addComment|updateIssueComment|updatePullRequestReviewComment)\b/,
  ],
  ["rerequest", /\brequestReviews(?:ByLogin)?\b/],
  ["resolve", /\b(?:un)?resolveReviewThread\b/],
];

// REST endpoints a write (any method but GET) reaches, by action, matched without a trailing slash; the first that matches
// wins.
const ENDPOINTS = [
  ["merge", /\/pulls\/\d+\/merge$|\/merges$/],
  ["rerequest", /\/requested_reviewers$/],
  ["reply", /\/(?:comments|replies|reviews)(?:\/|$)/],
  ["push", /\/git\/refs(?:\/|$)|\/contents(?:\/|$)|\/update-branch$|\/merge-upstream$/],
];

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
// Characters that end a simple command outside quotes.
const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")"]);
// git's own options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
// gh api's options that take the next word as their value.
const API_VALUE_OPTIONS = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);
const MAX_DEPTH = 8;

const base = (word) => path.basename(word).replace(/\.exe$/i, "");

// A here-document's operator at `index` (`<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<-WORD`): its terminator, whether tabs
// before the terminator are ignored, and where the operator ends. Null for `<<<` or anything else.
function heredocAt(text, index) {
  if (text[index] !== "<" || text[index + 1] !== "<" || text[index + 2] === "<") return null;
  let at = index + 2;
  const tabs = text[at] === "-";
  if (tabs) at += 1;
  while (text[at] === " " || text[at] === "\t") at += 1;
  let delimiter = "";
  while (at < text.length && !/\s/.test(text[at]) && !SEPARATORS.has(text[at]) && text[at] !== "<" && text[at] !== ">") {
    if (!"'\"\\".includes(text[at])) delimiter += text[at];
    at += 1;
  }
  return delimiter ? { delimiter, tabs, end: at } : null;
}

// The body of each pending here-document starts after the newline at `newline`: the index of the newline that ends the
// last terminator line, or the text's end. The body is text for a command, never commands of its own.
function afterHeredocs(text, newline, pending) {
  let at = newline;
  for (const { delimiter, tabs } of pending) {
    while (at < text.length) {
      const start = at + 1;
      const stop = text.indexOf("\n", start);
      at = stop < 0 ? text.length : stop;
      const line = text.slice(start, at);
      if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
    }
  }
  pending.length = 0;
  return at;
}

// The end of a `$(` substitution starting at `start` (just past the paren), or the text's end.
function closingParen(text, start) {
  let depth = 1;
  let quote = null;
  const pending = [];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const heredoc = quote ? null : heredocAt(text, index);
    if (heredoc) {
      pending.push(heredoc);
      index = heredoc.end - 1;
    } else if (char === "\n" && !quote && pending.length) index = afterHeredocs(text, index, pending) - 1;
    else if (char === "\\" && quote !== "'") index += 1;
    else if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && (depth -= 1) === 0) return index;
  }
  return text.length;
}

/**
 * A command line as its simple commands, each a list of words with quotes and escapes removed. Command substitutions
 * (`$(…)`, backticks) and what `sh -c` or `eval` run are split out as commands of their own.
 */
function commandsOf(text, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  const commands = [];
  const nested = [];
  let words = [];
  let word = null;
  let quote = null;
  // Here-documents opened on the current line, whose bodies start at its end.
  const heredocs = [];
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === "\\") {
      word = (word ?? "") + (text[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === "$" && text[index + 1] === "(") {
      const end = closingParen(text, index + 2);
      nested.push(text.slice(index + 2, end));
      word = (word ?? "") + "$()";
      index = end;
      continue;
    }
    if (char === "`") {
      const end = text.indexOf("`", index + 1);
      const stop = end < 0 ? text.length : end;
      nested.push(text.slice(index + 1, stop));
      word = (word ?? "") + "``";
      index = stop;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
      continue;
    }
    const heredoc = heredocAt(text, index);
    if (heredoc) {
      endWord();
      heredocs.push(heredoc);
      index = heredoc.end - 1;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\n" && heredocs.length) {
      endCommand();
      index = afterHeredocs(text, index, heredocs) - 1;
    } else if (SEPARATORS.has(char)) endCommand();
    else if (/\s/.test(char)) endWord();
    else word = (word ?? "") + char;
  }
  endCommand();
  for (const command of commands) {
    command.forEach((each, index) => {
      // `bash -c '…'`, `zsh -lc '…'`: the word after the flag is a script.
      if (SHELLS.has(base(each))) {
        const flag = command.slice(index + 1).findIndex((item) => /^-[a-z]*c[a-z]*$/i.test(item));
        if (flag >= 0 && command[index + 2 + flag] !== undefined) nested.push(command[index + 2 + flag]);
      }
      if (each === "eval") nested.push(command.slice(index + 1).join(" "));
    });
  }
  return [...commands, ...nested.flatMap((script) => commandsOf(script, depth + 1))];
}

// `git … push`, after git's own options; also an alias set inline to push (`git -c alias.ship=push ship`).
function gitAction(words) {
  let index = 0;
  while (index < words.length && words[index].startsWith("-")) {
    const option = words[index];
    if (option === "-c" && /^alias\.[^=]+=.*\bpush\b/.test(words[index + 1] ?? "")) return "push";
    index += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  const subcommand = words[index];
  if (subcommand === "push" || subcommand === "send-pack") return "push";
  if (subcommand === "subtree" && words.slice(index + 1).includes("push")) return "push";
  return words.slice(index).some((word) => /^alias\.[^=]+=.*\bpush\b/.test(word)) ? "push" : null;
}

function mutationAction(body) {
  return MUTATIONS.filter(([, pattern]) => pattern.test(body)).map(([action]) => action);
}

// `gh api …`: a GraphQL call by the mutations its body names (the whole command line, so a body piped in counts), a
// REST call by the endpoint it writes to.
function apiActions(words, line) {
  let method = null;
  let fields = false;
  let endpoint = null;
  let unreadable = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const [flag, inline] =
      word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
    const short = /^-[XfF]./.test(word) ? [word.slice(0, 2), word.slice(2)] : null;
    const name = short ? short[0] : flag;
    const takesValue = API_VALUE_OPTIONS.has(name);
    const value = short ? short[1] : (inline ?? (takesValue ? words[index + 1] : undefined));
    if (takesValue && !short && inline === undefined) index += 1;
    if (name === "-X" || name === "--method") method = String(value ?? "").toUpperCase();
    else if (["-f", "--raw-field", "-F", "--field"].includes(name)) {
      fields = true;
      if ((value ?? "").startsWith("query=@")) unreadable = true;
    } else if (name === "--input") {
      fields = true;
      if (value !== "-") unreadable = true;
    } else if (!word.startsWith("-") && endpoint === null) endpoint = word;
  }
  if (endpoint === "graphql") return [...mutationAction(line), ...(unreadable ? ["graphql-file"] : [])];
  if ((method ?? (fields ? "POST" : "GET")) === "GET" || !endpoint) return [];
  const route = `/${endpoint
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")}`;
  const match = ENDPOINTS.find(([, pattern]) => pattern.test(route));
  return match ? [match[0]] : [];
}

// `gh pr merge`, `gh pr comment`, `gh pr edit --add-reviewer`, `gh pr update-branch`, `gh repo sync`, `gh api …`.
function ghActions(words, line) {
  const positional = [];
  let index = 0;
  while (index < words.length && positional.length < 2) {
    const word = words[index];
    if (word === "-R" || word === "--repo") index += 2;
    else {
      if (!word.startsWith("-")) positional.push(word);
      index += 1;
    }
  }
  const [group, command] = positional;
  const rest = words.slice(index);
  if (group === "api") return apiActions(words.slice(words.indexOf("api") + 1), line);
  if (group === "pr" && command === "merge") return ["merge"];
  // Both write commits to a branch on GitHub.
  if ((group === "pr" && command === "update-branch") || (group === "repo" && command === "sync")) return ["push"];
  if ((group === "pr" && (command === "comment" || command === "review")) || (group === "issue" && command === "comment")) return ["reply"];
  if (group === "pr" && command === "edit" && rest.some((word) => word === "--add-reviewer" || word.startsWith("--add-reviewer="))) return ["rerequest"];
  return [];
}

/** The guarded actions a command line takes: "push", "reply", "rerequest", "resolve", "merge" or "graphql-file". */
function actionsOf(line) {
  const actions = new Set();
  for (const words of commandsOf(line)) {
    // Anywhere in the command, so a wrapper (`env X=1`, `sudo`, `xargs`, `nohup`, `time`…) or a keyword can't hide it.
    words.forEach((word, index) => {
      const name = base(word);
      if (name === "git") {
        const action = gitAction(words.slice(index + 1));
        if (action) actions.add(action);
      }
      if (name === "gh") for (const action of ghActions(words.slice(index + 1), line)) actions.add(action);
    });
  }
  return actions;
}

/**
 * Why a babysit Run's guard ({ level, resolveThreads }) refuses `command`, or null when it may run. Shell commands only:
 * `git push` below level 3, GitHub replies below 4, re-requesting review below 5, resolving threads unless that is on,
 * and merging never.
 */
function babysitDenial(command, guard) {
  const actions = actionsOf(String(command ?? ""));
  if (actions.has("merge")) return NEVER_MERGES;
  if (actions.has("graphql-file")) return UNREADABLE_GRAPHQL;
  const refused = ORDER.find((action) => actions.has(action) && !ACTIONS[action].allowed(guard));
  if (!refused) return null;
  const title = (BABYSIT_LEVELS.find((entry) => entry.level === guard.level) ?? BABYSIT_LEVELS[0]).title;
  return `Babysit level ${title} doesn't allow ${ACTIONS[refused].text}. Change it in Settings › Experimental › Babysit PRs.`;
}

module.exports = { babysitDenial };
