export const SECRET_LIMITS = Object.freeze({ count: 500, valueBytes: 64 * 1024, noteChars: 500, fileNameChars: 128, projects: 100 });
export const SECRET_KINDS = Object.freeze(["text", "file", "login"]);
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
  changedOn: (name) => `Changed on ${name}`,
  logins: {
    title: "Logins",
    intro:
      "A saved login is filled only into its own site in the Browser panel. Agents never get the password back, and can't read that page's script until it moves on.",
    empty: "No logins yet. Add one, or import your browser's passwords on a computer.",
    add: "Add login",
    importPasswords: "Import passwords…",
    import: "Import",
    site: "Site address",
    sitePlaceholder: "https://github.com",
    username: "Username",
    password: "Password",
    replacePassword: "Replace password",
    passwordPlaceholder: "Type the password",
    badSite: "Use a full address that starts with https://, like https://github.com.",
    exportHelp:
      "Export from Chrome, Arc or Edge in Settings › Passwords › Export, Safari in File › Export › Passwords, Firefox in Passwords › Export. 1Password and Bitwarden export as CSV.",
    deleteExport: "The file holds every password in plain text. Delete it once the import is done.",
    removeExport: "Delete the file after importing",
    exportDeleted: "The exported file is deleted.",
    phoneImport: "Import passwords from Milagre on your computer.",
    imported: (count) => `Imported ${count} ${count === 1 ? "login" : "logins"}.`,
    removeConfirm: (site, username) => `Delete the login for ${username ? `${username} on ` : ""}${site}? Agents can't sign in there from their next command.`,
    nobody: "No username",
  },
  sharing: {
    title: "Share with",
    intro: "Secrets you save here are sent to the computers you pick, over the encrypted link between your computers. They can't read values back.",
    empty: "Pair another computer in Phone & sharing to share secrets with it.",
    online: "Online",
    offline: "Offline",
    removing: (name) => `Removing from ${name} when it's back online`,
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

/** Whether a phone call carries a secret value: it may only travel over the end-to-end channel or loopback. */
export function carriesSecretValue(method, args) {
  const first = Array.isArray(args) ? args[0] : undefined;
  return (
    method === "secrets:set" ||
    (method === "agent:answer-question" && (String(first?.requestId ?? "").startsWith("milagre-secret-") || first?.secretAnswer === true))
  );
}

function hashText(text) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  return hash.toString(16).toUpperCase().padStart(8, "0").slice(0, 6);
}

/** The name a login is saved under: the site and a short hash of the site and username, so each pair has one. */
export function loginName(origin, username) {
  const host = String(origin)
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `LOGIN_${host || "SITE"}_${hashText(`${origin}\n${username}`)}`;
}

/** The site of an origin without its scheme, as a row names it. */
export function loginHost(origin) {
  return String(origin).replace(/^[a-z]+:\/\//i, "");
}

/** The origin a typed site address means, or why it can't be one: https, or http on this computer. */
export function loginSite(site) {
  const text = String(site ?? "").trim();
  if (!text) return { origin: null, error: null };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { origin: null, error: SECRETS_COPY.logins.badSite };
  }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !local) return { origin: null, error: SECRETS_COPY.logins.badSite };
  return { origin: url.origin, error: null };
}

/** The rows of a CSV text, each with the line it starts on. */
function csvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const end = () => {
    row.push(field);
    if (row.some((cell) => cell !== "")) rows.push(Object.assign(row, { line: start }));
    row = [];
    field = "";
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const crlf = char === "\r" && text[index + 1] === "\n";
    if (char === "\n" || (char === "\r" && !crlf)) line++;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (crlf) continue;
    else if (char === "\n" || char === "\r") {
      end();
      start = line;
    } else field += char;
  }
  if (quoted) throw new Error("The file has a quote that never closes, so it wasn't imported.");
  end();
  return rows;
}

/**
 * Logins from a browser's or password manager's CSV export (Chrome, Arc, Edge, Safari, Firefox, 1Password, Bitwarden):
 * url, username and password columns by header, plus a note when there is one. One-time-code columns are ignored. A
 * row that can't be a login is reported with its line, never dropped silently; a broken file throws.
 */
export function parseLoginCsv(text) {
  const [header, ...rows] = csvRows(String(text).replace(/^﻿/, ""));
  if (!header) throw new Error("The file is empty.");
  const column = (...names) => header.findIndex((cell) => names.includes(cell.trim().toLowerCase()));
  const url = column("url", "login_uri", "website", "web site");
  const username = column("username", "login_username", "user name", "login");
  const password = column("password", "login_password");
  const note = column("note", "notes");
  if (url < 0 || password < 0) throw new Error("The file has no url and password columns, so it isn't a passwords export.");
  const logins = [];
  const skipped = [];
  for (const row of rows) {
    const { line } = row;
    let origin = null;
    try {
      origin = new URL(row[url]).origin;
    } catch {}
    if (!origin || origin === "null") skipped.push({ row: line, site: row[url] ?? "", reason: "The address isn't a web address." });
    else if (!row[password]) skipped.push({ row: line, site: origin, reason: "No password." });
    else
      logins.push({
        line,
        origin,
        username: username >= 0 ? (row[username] ?? "") : "",
        password: row[password],
        note: note >= 0 && row[note] ? row[note] : null,
      });
  }
  return { logins, skipped };
}
