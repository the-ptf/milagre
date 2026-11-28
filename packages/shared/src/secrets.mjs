export const SECRET_LIMITS = Object.freeze({ count: 500, valueBytes: 64 * 1024, noteChars: 500, fileNameChars: 128, projects: 100 });
export const SECRET_KINDS = Object.freeze(["text", "file"]);
export const SECRET_DELIVERIES = Object.freeze(["on-demand", "ambient"]);
export const REDACT_MIN_CHARS = 8;
const HINT_MIN_CHARS = 12;

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "LANG",
  "TERM",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "PROMPT_COMMAND",
  "IFS",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "BROWSER",
  "AGENT_BROWSER_SESSION",
  "ELECTRON_RUN_AS_NODE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
]);
const RESERVED_PREFIXES = [
  "LD_",
  "DYLD_",
  "GIT_",
  "SSH_",
  "NPM_CONFIG_",
  "MILAGRE_",
  "ANTHROPIC_",
  "OPENAI_",
  "CLAUDE_",
  "CODEX_",
  "GEMINI_",
  "GOOGLE_GENAI_",
  "KIRO_",
  "XDG_",
];

/** Why a name can't hold a secret, or null. Names are environment variable names an agent's commands receive. */
export function secretNameProblem(name) {
  if (typeof name !== "string" || !NAME.test(name)) return "Use capital letters, digits and underscores, starting with a letter (64 at most).";
  if (RESERVED.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)) || name.endsWith("_BASE_URL"))
    return `${name} is reserved: it changes how programs, Git or agents run.`;
  return null;
}

/** The last four characters, shown so a write-only value can still be recognised. Short values get none. */
export function secretHint(value) {
  return typeof value === "string" && value.length >= HINT_MIN_CHARS ? value.slice(-4) : null;
}

/** Whether a secret reaches a Chat: its Project's origin (`originId`) is in scope, and an unattended run needs the secret's consent. */
export function secretReaches(secret, { origin, unattended = false }) {
  if (unattended && !secret.unattended) return false;
  if (secret.projects === "all") return true;
  return Boolean(origin) && Array.isArray(secret.projects) && secret.projects.includes(origin);
}

/** KEY=value lines of a .env file. Comments, blanks and `export ` are skipped; quotes are removed; double quotes keep \n. */
export function parseDotenv(text) {
  const entries = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else value = value.replace(/\s+#.*$/, "");
    entries.push({ name: match[1], value });
  }
  return entries;
}

function needles(secret) {
  const value = String(secret.value ?? "");
  const found = new Set();
  const add = (text) => {
    if (text.length >= REDACT_MIN_CHARS) found.add(text);
  };
  add(value);
  if (secret.kind === "file") for (const line of value.split(/\r?\n/)) add(line.trim());
  const encoded = base64(value).replace(/=+$/, "");
  add(encoded);
  add(encoded.replaceAll("+", "-").replaceAll("/", "_"));
  add(encodeURIComponent(value));
  add(JSON.stringify(value).slice(1, -1));
  add([...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  return [...found];
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const [a, b = 0, c = 0] = [bytes[index], bytes[index + 1], bytes[index + 2]];
    const chunk = (a << 16) | (b << 8) | c;
    out += ALPHABET[(chunk >> 18) & 63] + ALPHABET[(chunk >> 12) & 63];
    out += index + 1 < bytes.length ? ALPHABET[(chunk >> 6) & 63] : "=";
    out += index + 2 < bytes.length ? ALPHABET[chunk & 63] : "=";
  }
  return out;
}

/** A function that replaces every known secret value in a string with `[secret NAME]`. Longest values first. */
export function secretRedactor(secrets) {
  const pairs = [];
  for (const secret of secrets) for (const needle of needles(secret)) pairs.push([needle, `[secret ${secret.name}]`]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return Object.assign((text) => text, { pending: () => 0 });
  const redact = (text) => {
    if (typeof text !== "string" || text.length < REDACT_MIN_CHARS) return text;
    let out = text;
    for (const [needle, label] of pairs) if (out.includes(needle)) out = out.split(needle).join(label);
    return out;
  };
  /** How many trailing characters could start a secret: a stream holds them back until the next chunk shows. */
  const pending = (text) => {
    let longest = 0;
    for (const [needle] of pairs) {
      for (let index = text.indexOf(needle[0], Math.max(0, text.length - needle.length + 1)); index !== -1; index = text.indexOf(needle[0], index + 1)) {
        if (text.length - index <= longest) break;
        if (needle.startsWith(text.slice(index))) {
          longest = text.length - index;
          break;
        }
      }
    }
    return longest;
  };
  return Object.assign(redact, { pending });
}

export const SECRETS_COPY = Object.freeze({
  title: "Secrets",
  intro: "Save a key once and agents use it one command at a time. After you save a value, Milagre never shows it again.",
  usage: "Agents run commands with milagre-secrets run --with NAME -- <command>. Every use is logged.",
  locked: "Secrets are locked on this computer. Open Milagre on it, or set up a computer key for unattended access.",
  empty: "No secrets yet. Add one here, or save one when an agent asks for it.",
  add: "Add secret",
  importEnv: "Import .env file",
  replace: "Replace value",
  remove: "Delete",
  removeConfirm: (name) => `Delete ${name}? Agents lose it from their next command.`,
  name: "Name",
  value: "Value",
  file: "File",
  note: "Note",
  projects: "Projects",
  allProjects: "All Projects",
  chosenProjects: "Chosen Projects",
  noProjects: "Choose at least one Project.",
  ambient: {
    label: "Keep in agents' environment",
    help: "Every command, MCP server and hook the agent starts can read it. Only for tools that need a variable all the time, like NPM_TOKEN.",
  },
  askEachUse: { label: "Ask before each use", help: "You allow or deny each command, on desktop or phone." },
  unattended: {
    label: "Allow unattended runs",
    help: "Routines, Heartbeats, babysitting and Orchestrator tasks can use it with nobody watching. They read issues, PRs and web pages, so allow only what they need.",
  },
  log: "Recent uses",
  noUses: "Not used in the last 30 days.",
  neverUsed: "Never used",
  lastUsed: (when) => `Used ${when}`,
  open: "Open Secrets",
  edit: "Edit",
  chooseFile: "Choose file…",
  valuePlaceholder: "Paste or type the secret",
  imported: (count) => `Imported ${count} ${count === 1 ? "secret" : "secrets"}.`,
  skipped: "Skipped",
  saveAs: {
    label: (name) => `Save as ${name}`,
    project: "This Project",
    all: "All Projects",
    none: "Don't save",
    replaces: (name) => `Replaces the saved ${name}.`,
  },
});

/** Where a secret reaches, in a few words: "All Projects", one origin, or a count. */
export function secretScopeText(projects) {
  if (projects === "all") return SECRETS_COPY.allProjects;
  if (!Array.isArray(projects) || !projects.length) return SECRETS_COPY.noProjects;
  return projects.length === 1 ? projects[0] : `${projects.length} Projects`;
}

/** The opt-ins a secret has, as short labels for a row. */
export function secretFlags(secret) {
  return [
    secret.delivery === "ambient" ? "In environment" : null,
    secret.askEachUse ? "Asks each use" : null,
    secret.unattended ? "Unattended runs" : null,
  ].filter(Boolean);
}
