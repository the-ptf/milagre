const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { MEMORY_BYTE_CAP, MEMORY_LINE_CAP } = require("@milagre/shared/bots");
const { EMPTY_MEMORY, writeAtomic } = require("./home.cjs");

// A bot's MEMORY.md: `## <section>` headings with notes under them, kept under MEMORY_LINE_CAP lines and
// MEMORY_BYTE_CAP bytes. Every write is redacted, keeps the text it replaced in memory/.journal/<id>.md so the profile
// can undo it, and lands with a rename. Lines the user wrote end with USER_MARK; the bot's writes never remove them,
// and every mark in what the bot writes is taken out, so it can't pass its lines off as the user's.

const USER_MARK = "<!-- user -->";
// The mark anywhere in a line, however it is spaced or cased, with the blanks before it.
const ANY_MARK = /[ \t]*<!--\s*user\s*-->/gi;
const REDACTED = "[redacted]";
const JOURNAL_ID = /^\d+-[0-9a-f]{8}$/;
const memoryFile = (home) => path.join(home, "MEMORY.md");
const journalFile = (home, id) => path.join(home, "memory", ".journal", `${id}.md`);

// The names that mark a value as a secret, in a `name=value`, `NAME: value` or JSON `"name": "value"` pair.
const SECRET_NAME = String.raw`(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)`;

// Token-shaped strings. A KEY=value pair goes whole, name and all: the name says what leaked. A URL's user and
// password go, and the rest of it stays.
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{6,}/g,
  /\bglpat-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:ant|proj)-[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bxox[abeprs]-[A-Za-z0-9-]+/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  // KEY=value and KEY: value, the name in capitals as in an environment.
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)(?:=|:[ \t]*)\S+/g,
  // name=value in any case, in a config line or a query string.
  new RegExp(String.raw`\b[\w-]*${SECRET_NAME}=[^\s&"']+`, "gi"),
  new RegExp(String.raw`"[\w-]*${SECRET_NAME}"\s*:\s*"[^"]+"`, "gi"),
];

function redactSecrets(text) {
  let result = String(text ?? "").replace(/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  for (const pattern of SECRETS) result = result.replace(pattern, REDACTED);
  // A bearer credential, told from prose ("bearer authentication") by a digit or a capital past its first letter.
  return result.replace(/\b([Bb]earer)\s+([A-Za-z0-9._~+/=-]{8,})/g, (match, word, value) => (/[A-Z0-9]/.test(value.slice(1)) ? `${word} ${REDACTED}` : match));
}

const countLines = (text) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);
const measure = (text) => ({ lines: countLines(text), bytes: Buffer.byteLength(text) });
const isUsers = (line) => line.trimEnd().endsWith(USER_MARK);
function unmarked(line) {
  const stripped = line.replace(ANY_MARK, "");
  return stripped === line ? line : stripped.trimEnd();
}
const markLine = (line) => (line.trim() === "" || line.startsWith("#") || isUsers(line) ? line : `${line.trimEnd()} ${USER_MARK}`);
const heading = (section) => `## ${section}`;

async function readText(home) {
  try {
    return await fs.readFile(memoryFile(home), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return EMPTY_MEMORY;
    throw error;
  }
}

async function readMemory(home) {
  const text = await readText(home);
  return { text, ...measure(text) };
}

// One write at a time per home, so a journal entry always holds the text the write replaced. One entry per bot home.
const queues = new Map();
function serial(home, work) {
  const run = (queues.get(home) ?? Promise.resolve()).then(work);
  queues.set(
    home,
    run.catch(() => {}),
  );
  return run;
}

async function commit(home, previous, next, now) {
  const journalId = `${Math.trunc(now)}-${randomBytes(4).toString("hex")}`;
  await fs.mkdir(path.dirname(journalFile(home, journalId)), { recursive: true });
  await writeAtomic(journalFile(home, journalId), previous);
  await writeAtomic(memoryFile(home), next);
  return { ...measure(next), journalId };
}

function checkCaps(previous, next) {
  const before = measure(previous);
  const after = measure(next);
  // A file already over a cap (the user's own save can pass it) still takes writes that shrink it.
  if (after.lines > MEMORY_LINE_CAP && after.lines >= before.lines)
    throw new Error(`MEMORY.md is full: ${MEMORY_LINE_CAP} lines max. Move older notes to memory/archive/ first.`);
  if (after.bytes > MEMORY_BYTE_CAP && after.bytes >= before.bytes)
    throw new Error(`MEMORY.md is full: ${MEMORY_BYTE_CAP / 1024} KB max. Move older notes to memory/archive/ first.`);
}

/** The text with `lines` added to, or put in place of, the section's notes. Replacing keeps the user's lines. */
function edit(text, section, lines, mode) {
  const all = text.replace(/\n$/, "").split("\n");
  const start = all.findIndex((line) => unmarked(line).trim() === heading(section));
  if (start === -1) {
    // The first section sits right under the title; later ones get a blank line before them.
    const last = all.at(-1) ?? "";
    const gap = last.trim() === "" || last.startsWith("#") ? [] : [""];
    return [...all, ...gap, heading(section), ...lines].join("\n") + "\n";
  }
  let end = all.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  if (end === -1) end = all.length;
  let body = all.slice(start + 1, end);
  // Blank lines that end the section stay at its end.
  let trailing = body.length;
  while (trailing > 0 && body[trailing - 1].trim() === "") trailing -= 1;
  const tail = body.slice(trailing);
  body = body.slice(0, trailing);
  const kept = mode === "replace" ? body.filter(isUsers) : body;
  return [...all.slice(0, start + 1), ...kept, ...lines, ...tail, ...all.slice(end)].join("\n") + "\n";
}

/** Adds to or replaces one section. The bot's writes are capped and can't mark lines as the user's. */
function writeMemory(home, { section, text, mode }, { now, by = "bot" }) {
  const name = unmarked(redactSecrets(String(section ?? "")))
    .replace(/\s+/g, " ")
    .replace(/^#+\s*/, "")
    .trim();
  if (!name) return Promise.reject(new Error("A memory section needs a name."));
  const lines = redactSecrets(String(text ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => (by === "user" ? markLine(line) : unmarked(line)));
  return serial(home, async () => {
    const previous = await readText(home);
    const next = edit(previous, name, lines, mode === "replace" ? "replace" : "append");
    if (by !== "user") checkCaps(previous, next);
    return commit(home, previous, next, now);
  });
}

/**
 * The user's whole-file save from the profile: every line that isn't in the stored text becomes theirs. With `base`,
 * the text the profile opened, a file that changed since (the bot wrote a note) is refused, so the save drops nothing.
 */
function saveMemoryByUser(home, text, { now, base }) {
  return serial(home, async () => {
    const previous = await readText(home);
    if (base !== undefined && previous !== base) throw new Error("MEMORY.md changed since you opened it. Reopen it to see the latest.");
    const stored = new Set(previous.split("\n").map((line) => unmarked(line).trimEnd()));
    const next = redactSecrets(String(text ?? ""))
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => (stored.has(unmarked(line).trimEnd()) ? line : markLine(line)))
      .join("\n");
    return commit(home, previous, next.endsWith("\n") ? next : `${next}\n`, now);
  });
}

/** Puts back the text a write replaced. The undo is journaled too, so it can be undone. */
function undoMemory(home, journalId, { now = Date.now() } = {}) {
  if (!JOURNAL_ID.test(String(journalId ?? ""))) return Promise.reject(new Error("Unknown memory change."));
  return serial(home, async () => {
    let before;
    try {
      before = await fs.readFile(journalFile(home, journalId), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("Unknown memory change.", { cause: error });
      throw error;
    }
    await commit(home, await readText(home), before, now);
  });
}

module.exports = { USER_MARK, readMemory, redactSecrets, saveMemoryByUser, undoMemory, writeMemory };
