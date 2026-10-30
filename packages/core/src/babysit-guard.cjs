// Babysit PRs: what a babysit Run's level lets its agent do on GitHub, enforced on each shell command the agent runs
// (claude-provider, codex-provider, acp-session), whatever its permission mode. The prompt asks; this refuses.
const path = require("node:path");
const { BABYSIT_LEVELS } = require("@milagre/shared/babysit");

const NEVER_MERGES = "Babysitting never merges.";
const NEVER_CLOSES = "Babysitting never closes or reopens the PR.";
// A GraphQL body in a file can't be read here (no I/O), so it could hold any mutation; no setting allows it.
const UNREADABLE_GRAPHQL = "Babysitting can't check a GraphQL request read from a file, so it's blocked.";
// A REST edit of a PR or issue whose body comes from a file (or stdin fed from one) could close it; no setting allows it.
const UNREADABLE_BODY = "Babysitting can't check a request body read from a file, so it's blocked.";

// What each guarded action is called in the denial, and whether a Run's guard ({ level, resolveThreads }, already the
// Run's effective values) allows it. Merging, closing and unreadable GraphQL are never allowed and have their own reasons.
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
  ["close", /\b(?:closePullRequest|reopenPullRequest)\b/],
  ["push", /\b(?:createCommitOnBranch|updateRefs?|createRef|deleteRef|updatePullRequestBranch)\b/],
  [
    "reply",
    /\b(?:addPullRequestReviewComment|addPullRequestReviewThreadReply|addPullRequestReviewThread|addPullRequestReview|submitPullRequestReview|addComment|updateIssueComment|updatePullRequestReviewComment|updatePullRequest|markPullRequestReadyForReview|convertPullRequestToDraft)\b/,
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
  // Editing the PR or issue itself (title, body, assignees, milestone); one that sets its state closes or reopens it (see
  // apiActions).
  ["reply", /\/(?:pulls|issues)\/\d+$/],
  ["reply", /\/issues\/\d+\/(?:labels|assignees)(?:\/|$)/],
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

const ESCAPES = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

// An ANSI-C quoted word (`$'…'`) starting at `start` (just past the `$'`): its text with the escapes bash decodes, and the
// index of its closing quote (or the text's end).
function ansiC(text, start) {
  let value = "";
  let index = start;
  while (index < text.length && text[index] !== "'") {
    const char = text[index];
    if (char !== "\\") {
      value += char;
      index += 1;
      continue;
    }
    const next = text[index + 1] ?? "";
    const code = (pattern, from, radix) => {
      const match = pattern.exec(text.slice(from));
      if (!match) return false;
      const point = Number.parseInt(match[0], radix);
      value += point <= 0x10ffff ? String.fromCodePoint(point) : "\uFFFD";
      index = from + match[0].length;
      return true;
    };
    if (next === "x" && code(/^[0-9a-fA-F]{1,2}/, index + 2, 16)) continue;
    if (next === "u" && code(/^[0-9a-fA-F]{1,4}/, index + 2, 16)) continue;
    if (next === "U" && code(/^[0-9a-fA-F]{1,8}/, index + 2, 16)) continue;
    if (/[0-7]/.test(next) && code(/^[0-7]{1,3}/, index + 1, 8)) continue;
    if (next === "c" && text[index + 2]) {
      value += String.fromCharCode(text.charCodeAt(index + 2) & 31);
      index += 3;
      continue;
    }
    value += ESCAPES[next] ?? `\\${next}`;
    index += 2;
  }
  return { value, end: index };
}

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

// Inside `(( … ))` or `$(( … ))`, `<<` is a shift, not a here-document: how many arithmetic groups are open after `index`.
function arithmeticAt(text, index, open) {
  if (text.startsWith("((", index)) return open + 1;
  if (open && text.startsWith("))", index)) return open - 1;
  return open;
}

// The end of a `$(` substitution starting at `start` (just past the paren), or the text's end.
function closingParen(text, start) {
  let depth = 1;
  let quote = null;
  // `$((` opens arithmetic.
  let arithmetic = text[start] === "(" ? 1 : 0;
  const pending = [];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (!quote) arithmetic = arithmeticAt(text, index, arithmetic);
    // A here-string (`<<<word`) is a plain redirect: its word is read as usual.
    if (!quote && text.startsWith("<<<", index)) {
      index += 2;
      continue;
    }
    const heredoc = quote || arithmetic ? null : heredocAt(text, index);
    if (heredoc) {
      pending.push(heredoc);
      index = heredoc.end - 1;
    } else if (char === "\n" && !quote && pending.length) index = afterHeredocs(text, index, pending) - 1;
    else if (char === "\\" && quote !== "'") index += 1;
    else if (quote) {
      // `$` stands for an ANSI-C quote (`$'…'`): it ends at a `'`, and a backslash escapes in it.
      if (char === (quote === "$" ? "'" : quote)) quote = null;
    } else if (char === "$" && text[index + 1] === "'") {
      quote = "$";
      index += 1;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && (depth -= 1) === 0) return index;
  }
  return text.length;
}

// A command that runs text as a script: a shell (`bash`, `sh -c`, `… | sh`), `eval`, `source` or `.`, or a command
// whose name comes from a substitution (`$(cat <<EOF …)` runs what cat prints).
const runsText = (words) => words.some((word) => SHELLS.has(base(word)) || word === "eval" || word === "source" || word === ".") || /\$\(\)|``/.test(words[0]);

/**
 * A command line as its simple commands, each a list of words with quotes and escapes removed. Command substitutions
 * (`$(…)`, backticks) are commands of their own. A here-document's body is text for its command and is skipped, unless
 * its line runs text as a script: then the body, every word on the line (`sh -c '…'`, `eval "…"`, `echo '…' | sh`) and
 * the line's substitutions (`eval "$(cat <<EOF …)"`) are scripts too. A here-string's word (`bash <<< "…"`) is a word
 * on its line, so the same holds for it. `scripts` says the text itself is one of those.
 */
function commandsOf(text, depth = 0, scripts = false) {
  if (depth > MAX_DEPTH) return [];
  const commands = [];
  // [text, whether what it prints runs too]
  const nested = [];
  let words = [];
  let word = null;
  let quote = null;
  let arithmetic = 0;
  // The current line: where its commands start, its substitutions, and the here-documents opened on it with their bodies.
  let lineStart = 0;
  let substitutions = [];
  const heredocs = [];
  let bodies = [];
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const endLine = () => {
    endCommand();
    const running = scripts || commands.slice(lineStart).some(runsText);
    for (const script of substitutions) nested.push([script, running]);
    if (running) {
      // A plain word reads the same again; only one that holds more than a word can hide a command.
      for (const each of commands.slice(lineStart)) for (const item of each) if (/[\s;&|()$`<'"\\]/.test(item)) nested.push([item, false]);
      for (const body of bodies) nested.push([body, false]);
    }
    lineStart = commands.length;
    substitutions = [];
    bodies = [];
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
      substitutions.push(text.slice(index + 2, end));
      word = (word ?? "") + "$()";
      index = end;
      continue;
    }
    if (char === "`") {
      const end = text.indexOf("`", index + 1);
      const stop = end < 0 ? text.length : end;
      substitutions.push(text.slice(index + 1, stop));
      word = (word ?? "") + "``";
      index = stop;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
      continue;
    }
    // ANSI-C quoting: read as bash decodes it, so `$'git' push` is a push.
    if (char === "$" && text[index + 1] === "'") {
      const { value, end } = ansiC(text, index + 2);
      word = (word ?? "") + value;
      index = end;
      continue;
    }
    arithmetic = arithmeticAt(text, index, arithmetic);
    if (text.startsWith("<<<", index)) {
      endWord();
      index += 2;
      continue;
    }
    const heredoc = arithmetic ? null : heredocAt(text, index);
    if (heredoc) {
      endWord();
      heredocs.push(heredoc);
      index = heredoc.end - 1;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\n") {
      if (heredocs.length) {
        const end = afterHeredocs(text, index, heredocs);
        bodies.push(text.slice(index + 1, end));
        index = end - 1;
      }
      endLine();
    } else if (SEPARATORS.has(char)) endCommand();
    else if (/\s/.test(char)) endWord();
    else word = (word ?? "") + char;
  }
  endLine();
  return [...commands, ...nested.flatMap(([script, running]) => commandsOf(script, depth + 1, running))];
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
  let input = null;
  const values = [];
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
      values.push(value ?? "");
      if ((value ?? "").startsWith("query=@")) unreadable = true;
    } else if (name === "--input") {
      fields = true;
      input = String(value ?? "");
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
  if (match && /\/(?:pulls|issues)\/\d+$/.test(route)) {
    // An edit that sets the state closes or reopens it: a field, or a JSON body seen on the line (piped in or a
    // here-string). A body that can't be seen (a file, or stdin fed from one) could too.
    if (values.some((value) => value.startsWith("state="))) return ["close"];
    if (input !== null) {
      if (input !== "-") return ["body-file"];
      // Read with every quote and backslash taken out, so no quoting or escaping of the key hides it.
      if (/\bstate\s*:/.test(line.replace(/["'\\]/g, ""))) return ["close"];
      if (!line.includes("{")) return ["body-file"];
    }
  }
  return match ? [match[0]] : [];
}

// `gh pr merge`, `gh pr close`/`reopen`, `gh pr comment`, `gh pr edit` (`--add-reviewer` re-requests review, anything else
// edits the PR like a reply), `gh pr ready`, `gh pr update-branch`, `gh repo sync`, `gh api …`.
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
  if ((group === "pr" || group === "issue") && (command === "close" || command === "reopen")) return ["close"];
  if (group === "issue" && command === "edit") return ["reply"];
  if (group === "pr" && command === "ready") return ["reply"];
  // Both write commits to a branch on GitHub.
  if ((group === "pr" && command === "update-branch") || (group === "repo" && command === "sync")) return ["push"];
  if ((group === "pr" && (command === "comment" || command === "review")) || (group === "issue" && command === "comment")) return ["reply"];
  if (group === "pr" && command === "edit") {
    let rerequest = false;
    let edits = false;
    for (let at = 0; at < rest.length; at += 1) {
      const word = rest[at];
      if (word === "--add-reviewer" || word === "-R" || word === "--repo") {
        rerequest ||= word === "--add-reviewer";
        at += 1;
      } else if (word.startsWith("--add-reviewer=")) rerequest = true;
      else if (word.startsWith("-") && !word.startsWith("--repo=")) edits = true;
    }
    return [...(rerequest ? ["rerequest"] : []), ...(edits || !rerequest ? ["reply"] : [])];
  }
  return [];
}

/**
 * The guarded actions a command line takes: "push", "reply", "rerequest", "resolve", "merge", "close", "graphql-file" or
 * "body-file".
 */
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
 * and merging, closing or reopening the PR never.
 */
function babysitDenial(command, guard) {
  const actions = actionsOf(String(command ?? ""));
  if (actions.has("merge")) return NEVER_MERGES;
  if (actions.has("close")) return NEVER_CLOSES;
  if (actions.has("graphql-file")) return UNREADABLE_GRAPHQL;
  if (actions.has("body-file")) return UNREADABLE_BODY;
  const refused = ORDER.find((action) => actions.has(action) && !ACTIONS[action].allowed(guard));
  if (!refused) return null;
  const title = (BABYSIT_LEVELS.find((entry) => entry.level === guard.level) ?? BABYSIT_LEVELS[0]).title;
  return `Babysit level ${title} doesn't allow ${ACTIONS[refused].text}. Change it in Settings › Experimental › Babysit PRs.`;
}

module.exports = { babysitDenial, commandsOf };
