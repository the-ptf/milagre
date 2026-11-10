// The privacy boundary of a Milagre bug report (issue #938): everything the report says passes through here on the host
// before the user sees it, and again before it is posted. Values Milagre knows are the user's (Projects, repositories,
// Worktrees, branches, computers, people) and anything that looks like a path, link, address, key or reference become
// placeholders; fenced code is dropped. Strict on purpose: a word too many replaced costs a maintainer a question, a
// word too few can break a confidentiality agreement, and GitHub keeps every version of an issue.
const { BUG_REPORT_KINDS, CODE_REMOVED } = require("@milagre/shared/bug-report");

// A trusted domain can still carry pairing tokens, private share IDs or report bodies. Only fixed public routes
// without userinfo, query, fragment, port or encoded/normalized content may bypass the content patterns below.
const PUBLIC_HOSTS = /^(?:(?:www|relay)\.)?milagre\.(?:cloud|dev)$/i;
const PUBLIC_SITE_PATH = /^\/(?:docs(?:\/cli)?|privacy|terms|download\/(?:mac-arm64|mac-x64|android|linux-appimage|linux-deb|linux-rpm))?\/?$/;
const PUBLIC_REPO_PATH = /^\/the-ptf\/milagre(?:-ade)?(?:\/(?:issues(?:\/(?:\d+|new))?|pull\/\d+|pulls|releases))?\/?$/;

function isPublicUrl(parsed, url) {
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return false;
  // Never preserve raw spellings which URL normalized away, including dot segments, backslashes and encoded hosts.
  if (url.includes("%") || (parsed.href !== url && parsed.href !== `${url}/`)) return false;
  if (/^(?:www\.)?milagre\.(?:cloud|dev)$/.test(parsed.hostname)) return PUBLIC_SITE_PATH.test(parsed.pathname);
  if (/^relay\.milagre\.(?:cloud|dev)$/.test(parsed.hostname)) return parsed.pathname === "/health";
  if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") return PUBLIC_REPO_PATH.test(parsed.pathname);
  return false;
}
// Names too common to identify anyone, so a Project called "app" doesn't eat every "app" in the text.
const COMMON = new Set(
  [
    ...BUG_REPORT_KINDS,
    "main master develop development dev trunk staging stage production prod head origin upstream release",
    "app apps web www api src lib libs test tests demo docs doc site server client mobile desktop core shared packages",
    "home code project projects repo repos chat chats milagre new default local example sample tmp temp work",
  ].flatMap((words) => words.split(" ")),
);
// Technology names that look like file names.
const TECH_NAMES = new Set(["node.js", "next.js", "nuxt.js", "vue.js", "react.js", "three.js", "d3.js", "express.js", "deno.js", "ember.js", "chart.js"]);
const FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|jsonc|json5|py|pyi|rb|go|rs|java|kt|kts|swift|m|mm|h|hpp|c|cc|cpp|cs|fs|php|scala|sql|md|mdx|txt|rst|yml|yaml|toml|ini|cfg|conf|env|lock|html|htm|css|scss|sass|less|vue|svelte|astro|sh|bash|zsh|fish|ps1|bat|cmd|xml|plist|gradle|pbxproj|xcodeproj|xcworkspace|xcconfig|entitlements|storyboard|xib|png|jpe?g|gif|svg|webp|heic|pdf|csv|tsv|xlsx?|docx?|pptx?|key|pem|p8|p12|log|db|sqlite|proto|graphql|gql|tf|tfvars|ipynb|r|dart|ex|exs|erl|hs|lua|pl|el|clj|zig|nim|sol|wasm|ipa|apk|aab|dmg|zip|tar|gz|tgz";
const HOST_TLDS =
  "local|lan|internal|intranet|corp|home|localdomain|com|net|org|io|dev|cloud|ai|co|me|sh|xyz|tech|app|so|gg|us|uk|de|br|fr|es|it|nl|pt|in|jp|cn|eu|ca|au|ch|se|no|fi|dk|pl|ru|kr|mx|ar";
// Uppercase words that come before a number without naming an issue (UTF-8, SHA-256, ISO-8601, GPT-5).
const NOT_ISSUE_KEYS = new Set([
  "UTF",
  "ISO",
  "SHA",
  "RFC",
  "AES",
  "RSA",
  "TLS",
  "SSL",
  "HTTP",
  "ES",
  "ECMA",
  "GPT",
  "IPV",
  "MP",
  "ARM",
  "IEEE",
  "WCAG",
  "CVE",
  "MD",
  "UTC",
  "GMT",
]);

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Characters a placeholder is written with while a report is redacted, so later patterns never touch it.
const OPEN = "\u0001";
const CLOSE = "\u0002";
// oxlint-disable-next-line no-control-regex -- the placeholder markers are control characters on purpose
const SENTINEL = /\u0001(\d+)\u0002/g;
// Text kept as it is (Milagre's own links), held aside so no later pattern reads inside it.
const KEEP_OPEN = "\u0003";
const KEEP_CLOSE = "\u0004";
// oxlint-disable-next-line no-control-regex -- as above
const KEPT = /\u0003(\d+)\u0004/g;
// oxlint-disable-next-line no-control-regex -- stripped from every input, so no text can forge a marker
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const isPlaceholder = (text) => /^["']?<[a-z]+(?:-[a-z]{1,2})?>["']?$/.test(text) || text === CODE_REMOVED;

/** A path-like value: matched as a prefix, with whatever path follows it. */
const isPathValue = (value) => /[/\\]/.test(value);

/**
 * Normalizes what the host knows into `{ kind, value }` entries worth matching: no duplicates, nothing too short or too
 * common, paths before names and longest first, so a Worktree's path is replaced before its Project's.
 * @param {{ kind: string; value: unknown }[]} known
 */
function knownEntries(known) {
  const seen = new Map();
  for (const entry of known ?? []) {
    if (!entry || typeof entry.value !== "string" || !BUG_REPORT_KINDS.includes(entry.kind)) continue;
    let value = entry.value.trim().replace(CONTROL, "");
    if (isPathValue(value)) value = value.replace(/[/\\]+$/, "");
    if (value.length < 3 || value.length > 500 || !/[a-z]/i.test(value)) continue;
    if (!isPathValue(value) && COMMON.has(value.toLowerCase())) continue;
    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, { kind: entry.kind, value });
  }
  // Paths first, so a folder takes the names inside it; then the rest, longest first.
  return [...seen.values()].sort((a, b) => Number(isPathValue(b.value)) - Number(isPathValue(a.value)) || b.value.length - a.value.length);
}

/**
 * The patterns, in order. Each replaces its match with a placeholder of its kind, or returns the text to keep.
 * @type {{ pattern: RegExp; kind?: string; replace?: (match: string, ...groups: string[]) => string | { kind: string; keep?: string; tail?: string } }[]}
 */
// Links go first, whole, before a known name inside one is replaced on its own.
const LINKS = [
  // Milagre's own stay; a GitHub pull request, issue or repository says which it was.
  {
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]}]+/gi,
    replace: (match) => linkKind(match),
  },
  { pattern: /\bwww\.[^\s<>"'`)\]}]+/gi, replace: (match) => linkKind(match) },
  // scp-style Git remotes, before emails: git@github.com:owner/repo.git
  { pattern: /\b[\w.-]+@[\w.-]+\.[a-z]{2,}:[\w./~-]+/gi, kind: "repo" },
];
const PATTERNS = [
  { pattern: /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi, kind: "email" },
  // Keys and tokens.
  {
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abposr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|glpat-[\w-]{20,}|npm_\w{30,}|lin_(?:api|oauth)_\w{20,}|SG\.[\w-]{16,}\.[\w-]{16,})\b/g,
    kind: "token",
  },
  { pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, kind: "token" },
  { pattern: /\b(Bearer|Basic|token)\s+[\w.~+/-]{16,}=*/gi, replace: (_match, word) => ({ kind: "token", keep: `${word} ` }) },
  {
    pattern: /\b([A-Za-z0-9_]*(?:key|token|secret|password|passwd|pwd|credential)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"']{6,}\3/gi,
    replace: (_match, name, separator) => ({ kind: "token", keep: `${name}${separator}` }),
  },
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, kind: "id" },
  { pattern: /\b[0-9a-f]{41,}\b/gi, kind: "token" },
  { pattern: /(?<![\w+/=-])(?=[\w+/-]*\d)(?=[\w+/-]*[a-z])(?=[\w+/-]*[A-Z])[\w+/-]{40,}={0,2}/g, kind: "token" },
  // Branches named by convention, before paths take them.
  // Not inside a path: ".milagre/report.json" and "src/fix/x" aren't branches.
  { pattern: /(?<![\w./-])(?:feature|feat|fix|bugfix|hotfix|chore|release|milagre|dependabot|renovate|codex|claude)\/[\w./-]*[\w-]/g, kind: "branch" },
  // Paths: Windows, absolute and home ones, and relative ones with two folders or a file at the end.
  { pattern: /\b[A-Za-z]:\\[^\s'"`<>|]+/g, kind: "path" },
  { pattern: /(?<![\w:/.~-])(?:~(?=\/)|)\/[\w.@%+-]+(?:\/[\w.@%+-]+)+\/?/g, kind: "path" },
  { pattern: /(?<![\w:/.~-])~\/[\w.@%+-]+/g, kind: "path" },
  { pattern: new RegExp(`(?<![\\w/.-])[\\w.-]+(?:\\/[\\w.-]+)+\\.(?:${FILE_EXTENSIONS})\\b`, "gi"), kind: "path" },
  { pattern: /(?<![\w/.-])(?=[\w./-]*[A-Za-z])[\w.-]+\/[\w.-]+\/[\w./-]*[\w-]/g, kind: "path" },
  // Addresses.
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, kind: "ip" },
  { pattern: /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, kind: "ip" },
  // File names, before hosts: "config.json" is a file, "api.example.com" a host.
  {
    pattern: new RegExp(`(?<![\\w/.-])[\\w-][\\w.-]+\\.(?:${FILE_EXTENSIONS})\\b`, "gi"),
    replace: (match) => (TECH_NAMES.has(match.toLowerCase()) ? match : "file"),
  },
  {
    pattern: new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${HOST_TLDS})\\b(?::\\d+)?`, "gi"),
    replace: (match) => (PUBLIC_HOSTS.test(match.replace(/:\d+$/, "")) || /^milagre\.app$/i.test(match) ? match : "host"),
  },
  // References to pull requests and issues, here or in another tracker.
  { pattern: /\b[\w.-]+\/[\w.-]+#\d+\b/g, kind: "pr" },
  { pattern: /\b(PR|pull request|merge request|MR)(\s+)#?\d+\b/gi, replace: (_match, word, space) => ({ kind: "pr", keep: `${word}${space}` }) },
  { pattern: /(?<![\w&#])#\d+\b/g, kind: "issue" },
  {
    pattern: /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g,
    replace: (match, prefix) => (NOT_ISSUE_KEYS.has(prefix) ? match : "issue"),
  },
  // People, by handle.
  { pattern: /(?<![\w.@/-])@[A-Za-z0-9][A-Za-z0-9-]{0,38}\b(?![/@.]\w)/g, kind: "person" },
  // Commits: hex with a digit and a letter, 7 to 40 long.
  { pattern: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, kind: "commit" },
];

function linkKind(raw) {
  // Sentence punctuation after a link isn't part of it.
  const url = raw.replace(/[.,;:!?]+$/, "");
  const tail = raw.slice(url.length);
  let parsed;
  const absolute = url.startsWith("www.") ? `https://${url}` : url;
  try {
    parsed = new URL(absolute);
  } catch {
    return { kind: "url", tail };
  }
  const host = parsed.hostname.toLowerCase();
  if (isPublicUrl(parsed, absolute)) return raw;
  if (host === "github.com" || host === "www.github.com" || host === "raw.githubusercontent.com") {
    if (/^\/[^/]+\/[^/]+\/pull\/\d+/.test(parsed.pathname)) return { kind: "pr", tail };
    if (/^\/[^/]+\/[^/]+\/issues\/\d+/.test(parsed.pathname)) return { kind: "issue", tail };
    if (/^\/[^/]+\/[^/]+\/?$/.test(parsed.pathname)) return { kind: "repo", tail };
  }
  if (/\/(?:pull|pulls|merge_requests)\/\d+/.test(parsed.pathname)) return { kind: "pr", tail };
  if (/\/(?:issues?|browse|ticket)\/[\w-]*\d+/.test(parsed.pathname)) return { kind: "issue", tail };
  return { kind: "url", tail };
}

/**
 * A redactor for one report: the same value gets the same placeholder in every field it shows up in. `redact` takes
 * each field; `finish` turns the fields' placeholders into their final names (`<repo>` alone, `<repo-a>` and
 * `<repo-b>` when there are two), skipping names the text already uses, so text the user edited keeps its own.
 * @param {{ kind: string; value: string }[]} known
 */
function createRedactor(known, { seed = new Map() } = {}) {
  const entries = knownEntries(known);
  const found = [];
  const ids = new Map();
  const taken = new Set();
  const keyOf = (kind, value) => `${kind}\u0000${value.toLowerCase()}`;
  const mark = (kind, value) => {
    const key = keyOf(kind, value);
    let id = ids.get(key);
    if (id === undefined) {
      id = found.length;
      found.push({ kind, value });
      ids.set(key, id);
    }
    return `${OPEN}${id}${CLOSE}`;
  };
  const kept = [];
  const keep = (text) => `${KEEP_OPEN}${kept.push(text) - 1}${KEEP_CLOSE}`;
  const guarded = (text) => text.includes(OPEN) || text.includes(CLOSE) || text.includes(KEEP_OPEN) || text.includes(KEEP_CLOSE);
  /** Runs `patterns` over `text`; a match that crosses a placeholder or kept text is left alone. */
  const apply = (text, patterns, keepMatches) => {
    let out = text;
    for (const { pattern, kind, replace } of patterns)
      out = out.replace(pattern, (match, ...groups) => {
        if (guarded(match)) return match;
        const result = replace ? replace(match, ...groups.slice(0, -2)) : kind;
        if (typeof result === "string") {
          // No public URL, hostname or other exception may shield a known private name. Host labels and URL path
          // separators do not follow prose's word boundaries, so use conservative substring matching here.
          const privateEntry = result === match && entries.find(({ value }) => match.toLowerCase().includes(value.toLowerCase()));
          if (privateEntry) return mark(keepMatches ? "url" : privateEntry.kind, match);
          return result === match || isPlaceholder(match) ? (keepMatches ? keep(match) : match) : mark(result, match);
        }
        const value = match.slice(result.keep?.length ?? 0, match.length - (result.tail?.length ?? 0));
        // A value already replaced, as in text the user edited ("API_KEY=<token>"), stays.
        if (isPlaceholder(value)) return match;
        return `${result.keep ?? ""}${mark(result.kind, value)}${result.tail ?? ""}`;
      });
    return out;
  };
  const knownPatterns = entries.map((entry) => ({
    entry,
    pattern: isPathValue(entry.value)
      ? new RegExp(`(?<![\\w.-])${escape(entry.value)}((?:[/\\\\][^\\s'"\`<>)\\]}\\u0001-\\u0004]*)?)`, "gi")
      : new RegExp(`(?<![\\w.-])${escape(entry.value)}(?![\\w-]|\\.\\w)`, "gi"),
  }));

  /** @param {string} text @param {{ dropCode?: boolean }} [options] */
  function redact(text, { dropCode = true } = {}) {
    let out = String(text ?? "").replace(CONTROL, "");
    for (const match of out.matchAll(/<([a-z]+)-([a-z]{1,2})>/g)) taken.add(`${match[1]}-${match[2]}`);
    for (const match of out.matchAll(/<([a-z]+)>/g)) taken.add(match[1]);
    if (dropCode) out = out.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, CODE_REMOVED);
    out = apply(out, LINKS, true);
    for (const { entry, pattern } of knownPatterns)
      out = out.replace(pattern, (match, ...args) => {
        if (guarded(match)) return match;
        const tail = isPathValue(entry.value) ? args[0] : "";
        const placed = mark(entry.kind, match.slice(0, match.length - tail.length));
        // What follows a known folder names something inside it, private too.
        return tail && tail.length > 1 ? `${placed}/${mark("path", tail)}` : placed;
      });
    out = apply(out, PATTERNS, false);
    return out.replace(KEPT, (_match, index) => kept[Number(index)]);
  }

  function names() {
    const byKind = new Map();
    const name = new Map();
    for (const [id, item] of found.entries()) {
      // A value an earlier pass already named keeps its name (seed): an edited report says <org> for the same org.
      const earlier = seed.get(keyOf(item.kind, item.value));
      if (earlier) name.set(id, earlier);
      else byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), id]);
    }
    for (const placeholder of seed.values()) taken.add(placeholder.slice(1, -1));
    for (const [kind, list] of byKind) {
      if (list.length === 1 && !taken.has(kind) && ![...taken].some((used) => used.startsWith(`${kind}-`))) {
        name.set(list[0], `<${kind}>`);
        continue;
      }
      let next = 0;
      for (const id of list) {
        let suffix;
        do suffix = letters(next++);
        while (taken.has(`${kind}-${suffix}`));
        name.set(id, `<${kind}-${suffix}>`);
      }
    }
    return name;
  }

  /** @param {string} text */
  function finish(text, name = names()) {
    return text.replace(SENTINEL, (_match, id) => name.get(Number(id)) ?? "<redacted>");
  }

  /** Every replaced value's placeholder, by kind and value, to seed a later pass over the same report. */
  function mapping(name = names()) {
    return new Map([...found.entries()].map(([id, item]) => [keyOf(item.kind, item.value), name.get(id)]));
  }

  return {
    redact,
    finish,
    names,
    mapping,
    /** How many distinct values were replaced so far. */
    get count() {
      return found.length;
    },
  };
}

const letters = (index) => (index < 26 ? String.fromCharCode(97 + index) : letters(Math.floor(index / 26) - 1) + letters(index % 26));

/**
 * Redacts each field with one redactor, so a value has one placeholder everywhere. `keepCode` names fields whose fenced
 * blocks stay (the host log, the error Milagre printed): they are redacted line by line like the rest.
 * @param {Record<string, string>} fields
 * @param {{ kind: string; value: string }[]} known
 * @param {{ keepCode?: string[]; seed?: Map<string, string> }} [options] `seed`: the `names` of an earlier pass.
 */
function redactFields(fields, known, { keepCode = [], seed } = {}) {
  const redactor = createRedactor(known, { seed });
  const marked = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redactor.redact(value, { dropCode: !keepCode.includes(key) })]));
  const name = redactor.names();
  return {
    fields: Object.fromEntries(Object.entries(marked).map(([key, value]) => [key, redactor.finish(value, name)])),
    redactions: redactor.count,
    names: new Map([...(seed ?? []), ...redactor.mapping(name)]),
  };
}

/** True when `text` needs nothing more replaced: what a report the user edited must be before it is posted. */
function isClean(text, known) {
  const redactor = createRedactor(known);
  return redactor.redact(text, { dropCode: false }) === String(text);
}

module.exports = { createRedactor, redactFields, isClean, knownEntries };
