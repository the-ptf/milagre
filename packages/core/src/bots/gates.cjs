const path = require("node:path");
const { insideRoot } = require("../agents/permissions.cjs");

// Gates: the actions a bot always needs the user's sign-off for, matched on the permission request
// its session raises (see permissions.cjs for the request shape). These are guardrails on known
// commands, not a sandbox: a script that runs `gh pr merge` inside itself is not seen here.

const KIND_LABEL = { merge: "Merge", publish: "Publish", post: "Post as you", delete: "Delete", spend: "Spend" };

// Each segment of a command (see splitCommand) is tested from its start, so `echo gh pr merge 1` is not a merge.
// `git push` and `rm` need their arguments read, so they are matched in code below.
// `spend` is reserved: no purchase or payment tools exist yet.
const DEFAULT_GATE_PATTERNS = Object.freeze([
  { kind: "merge", pattern: /^gh pr merge\b/ },
  { kind: "merge", pattern: /^gh api\b.*\bpulls\/\d+\/merge\b/ },
  { kind: "publish", pattern: /^eas (update|submit)\b/ },
  { kind: "publish", pattern: /^eas build\b.*\s--auto-submit\b/ },
  { kind: "publish", pattern: /^node (\.\/)?scripts\/asc\.mjs (submit|release|beta)\b/ },
  { kind: "publish", pattern: /^(npm|pnpm|bun|yarn( npm)?) publish\b/ },
  { kind: "publish", pattern: /^gh release create\b/ },
  { kind: "publish", pattern: /^vercel\b.*\s--prod(uction)?\b/ },
  { kind: "publish", pattern: /^wrangler (pages )?(deploy|publish)\b/ },
  { kind: "publish", pattern: /^gh workflow run \S*(publish|release|deploy)/ },
  { kind: "post", pattern: /^gh (pr|issue) comment\b/ },
  { kind: "post", pattern: /^gh pr review\b/ },
  { kind: "post", pattern: /^curl\b.*(hooks\.slack\.com|discord(app)?\.com\/api\/webhooks)/ },
  { kind: "delete", pattern: /^gh repo delete\b/ },
  { kind: "delete", pattern: /^gh api\b.*\s(-X|--method)[ =]?DELETE\b/ },
]);

// MCP tools, by name (`mcp__<server>__<tool>`). Milagre's own tools only touch the Chat and never gate.
const MCP_PATTERNS = Object.freeze([
  { kind: "merge", pattern: /^mcp__(?!milagre__).*__\w*merge/i },
  { kind: "delete", pattern: /^mcp__(?!milagre__).*__\w*(delete|destroy)/i },
  { kind: "post", pattern: /^mcp__(?!milagre__).*(slack|gmail|discord|linear).*(send|post|create|reply|comment)/i },
]);

// Words that run the command after them.
const WRAPPERS = new Set(["env", "sudo", "command", "exec", "time", "nohup", "nice"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// A command line -> its simple commands, each a list of words with the quotes taken off. Splits on
// `&&`, `||`, `;`, `|`, `&`, newlines, subshells and command substitutions outside quotes.
function parse(command) {
  const segments = [];
  let words = [];
  let word = null;
  let quote = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const text = String(command ?? "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && next !== undefined && '"\\$`'.includes(next)) {
        word += next;
        i++;
      } else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\") {
      if (next !== "\n" && next !== undefined) word = (word ?? "") + next;
      i++;
    } else if (c === " " || c === "\t") endWord();
    else if (c === "#" && word === null) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === "$" && next === "(") {
      endSegment();
      i++;
    } else if ("\n;&|()`".includes(c)) endSegment();
    else word = (word ?? "") + c;
  }
  endSegment();
  return segments;
}

// One simple command's words -> the command that actually runs: without leading assignments and
// wrappers, with `npx -y pkg@1` as `pkg` and a program's path as its name. A shell's `-c` script
// (and `eval`) is parsed again, so the result is a list.
function normalize(words) {
  let rest = [...words];
  for (;;) {
    while (rest.length && ASSIGNMENT.test(rest[0])) rest.shift();
    if (!rest.length) return [];
    const name = path.basename(rest[0]);
    if (WRAPPERS.has(name)) {
      rest.shift();
      while (rest.length && rest[0].startsWith("-")) rest.shift();
      continue;
    }
    if (SHELLS.has(name)) {
      const flag = rest.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
      if (flag > 0 && rest[flag + 1] !== undefined) return parse(rest[flag + 1]).flatMap(normalize);
    }
    if (name === "eval") return parse(rest.slice(1).join(" ")).flatMap(normalize);
    if (PACKAGE_RUNNERS.has(name) || ((name === "pnpm" || name === "yarn") && rest[1] === "dlx")) {
      rest.splice(0, name === "pnpm" || name === "yarn" ? 2 : 1);
      while (rest.length && rest[0].startsWith("-")) rest.shift();
      if (!rest.length) return [];
      // `wrangler@4.147.0` -> `wrangler`, `@scope/pkg@1` -> `@scope/pkg`; eas-cli runs as `eas`.
      rest[0] = rest[0].replace(/(.)@[^/]*$/, "$1");
      if (rest[0] === "eas-cli") rest[0] = "eas";
      continue;
    }
    rest[0] = name;
    return [rest];
  }
}

/** A command line -> the simple commands it runs, normalized and joined by single spaces. */
function splitCommand(command) {
  return parse(command)
    .flatMap(normalize)
    .map((words) => words.join(" "));
}

// `git -C dir -c k=v push …` -> the words after `git`'s own options.
function gitArgs(words) {
  let index = 1;
  while (index < words.length && words[index].startsWith("-")) index += words[index] === "-C" || words[index] === "-c" ? 2 : 1;
  return words.slice(index);
}

const DEFAULT_BRANCHES = new Set(["main", "master"]);

// `git push`: a force push or a branch deletion is a delete, a push to main or master is a merge.
function gitPushGate(words) {
  const args = gitArgs(words);
  if (args[0] !== "push") return null;
  const flags = args.slice(1).filter((word) => word.startsWith("-"));
  const positional = args.slice(1).filter((word) => !word.startsWith("-"));
  const refspecs = positional.slice(1);
  const force = flags.some((flag) => /^(--force(-with-lease)?(=.*)?|--delete|-[a-zA-Z]*[fd][a-zA-Z]*)$/.test(flag));
  if (force || refspecs.some((spec) => spec.startsWith("+") || spec.startsWith(":"))) return { kind: "delete" };
  const branch = refspecs
    .map((spec) =>
      spec
        .split(":")
        .at(-1)
        .replace(/^refs\/heads\//, ""),
    )
    .find((name) => DEFAULT_BRANCHES.has(name));
  return branch ? { kind: "merge", title: `Push to ${branch}` } : null;
}

// `rm -r` on anything that isn't strictly inside the working folder. The folder itself counts as outside.
function rmGate(words, cwd) {
  if (words[0] !== "rm") return null;
  const flags = words.slice(1).filter((word) => word.startsWith("-"));
  if (!flags.some((flag) => flag === "--recursive" || /^-[a-zA-Z]*[rR]/.test(flag))) return null;
  const targets = [];
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (/^\d*[<>]/.test(word)) {
      // A redirection, and its file when it stands on its own.
      if (/^\d*[<>]+&?$/.test(word)) index++;
      continue;
    }
    if (!word.startsWith("-")) targets.push(word);
  }
  const outside = targets.some((target) => {
    if (target.startsWith("~") || target.startsWith("$")) return true;
    if (!cwd) return path.isAbsolute(target) || target.split("/").includes("..");
    return !insideRoot(cwd, [path.resolve(cwd, target)]);
  });
  return outside ? { kind: "delete" } : null;
}

// `gh … --repo owner/name` (or `-R`, `--repo=`): the grant target.
function repoFlag(words) {
  if (words[0] !== "gh") return null;
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (word === "--repo" || word === "-R") return words[index + 1] ?? null;
    if (word.startsWith("--repo=")) return word.slice("--repo=".length);
  }
  return null;
}

function prTitle(words) {
  const after = words.slice(words.indexOf("merge") + 1);
  for (const word of after) {
    const number = /^#?(\d+)$/.exec(word)?.[1] ?? /\/pull\/(\d+)\b/.exec(word)?.[1];
    if (number) return `Merge PR #${number}`;
  }
  return null;
}

function segmentGate(words, cwd, extra) {
  const segment = words.join(" ");
  const special = gitPushGate(words) ?? rmGate(words, cwd);
  if (special) return { ...special, segment };
  const found = DEFAULT_GATE_PATTERNS.find(({ pattern }) => pattern.test(segment));
  if (found) return { kind: found.kind, title: found.kind === "merge" && words[1] === "pr" ? prTitle(words) : null, segment };
  const added = extra.find(({ prefix }) => {
    const wanted = splitCommand(prefix)[0];
    return wanted && (segment === wanted || segment.startsWith(`${wanted} `));
  });
  return added ? { kind: added.kind, segment } : null;
}

// Claude's card shows an MCP tool by its display name ("Send Message"): its own name is `toolName`. Codex names an MCP
// tool only in its card's title: `Allow the slack MCP server to run tool "send_message"?`.
function mcpToolName(request) {
  if (request.toolName?.startsWith("mcp__")) return request.toolName;
  if (request.tool?.startsWith("mcp__")) return request.tool;
  const server = /^MCP: (.+)$/.exec(request.tool ?? "")?.[1];
  const tool = /run tool "([^"]+)"/.exec(request.title ?? "")?.[1];
  return server && tool ? `mcp__${server}__${tool}` : null;
}

/**
 * The gate a permission request falls under, or null. `extra` adds a template's own command prefixes.
 * The target is the command's `--repo`/`-R` value, or null for the caller to fill in with the Chat's Project.
 */
function matchGate(request, { extra = [] } = {}) {
  const mcp = mcpToolName(request);
  if (mcp) {
    const found = MCP_PATTERNS.find(({ pattern }) => pattern.test(mcp));
    return found ? { kind: found.kind, title: `${KIND_LABEL[found.kind]}: ${mcp}`, command: mcp, target: null } : null;
  }
  if (typeof request.command !== "string") return null;
  for (const words of parse(request.command).flatMap(normalize)) {
    const gate = segmentGate(words, request.cwd, extra);
    if (gate)
      return {
        kind: gate.kind,
        title: gate.title ?? `${KIND_LABEL[gate.kind]}: ${gate.segment}`,
        command: request.command,
        target: repoFlag(words),
      };
  }
  return null;
}

module.exports = { DEFAULT_GATE_PATTERNS, matchGate, splitCommand };
