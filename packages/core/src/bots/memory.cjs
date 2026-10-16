const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { MEMORY_BYTE_CAP, MEMORY_LINE_CAP } = require("@milagre/shared/bots");
const { EMPTY_MEMORY, writeAtomic } = require("./home.cjs");

// A bot's MEMORY.md: `## <section>` headings with notes under them, kept under MEMORY_LINE_CAP lines and
// MEMORY_BYTE_CAP bytes. Every write is redacted, keeps the text it replaced in memory/.journal/<id>.md so the profile
// can undo it, and lands with a rename. Lines the user wrote end with VICTOR_MARK; the bot's writes never remove them.

const VICTOR_MARK = "<!-- victor -->";
const REDACTED = "[redacted]";
const JOURNAL_ID = /^\d+-[0-9a-f]{8}$/;
const memoryFile = (home) => path.join(home, "MEMORY.md");
const journalFile = (home, id) => path.join(home, "memory", ".journal", `${id}.md`);

// Token-shaped strings. A KEY=value pair goes whole, name and all: the name says what leaked.
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
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
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)=\S+/g,
];

function redactSecrets(text) {
  let result = String(text ?? "");
  for (const pattern of SECRETS) result = result.replace(pattern, REDACTED);
  // A bearer credential, told from prose ("bearer authentication") by a digit or a capital past its first letter.
  return result.replace(/\b([Bb]earer)\s+([A-Za-z0-9._~+/=-]{8,})/g, (match, word, value) => (/[A-Z0-9]/.test(value.slice(1)) ? `${word} ${REDACTED}` : match));
}

const countLines = (text) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);
const measure = (text) => ({ lines: countLines(text), bytes: Buffer.byteLength(text) });
const isVictors = (line) => line.trimEnd().endsWith(VICTOR_MARK);
const unmarked = (line) => (isVictors(line) ? line.trimEnd().slice(0, -VICTOR_MARK.length).trimEnd() : line);
const markLine = (line) => (line.trim() === "" || line.startsWith("#") || isVictors(line) ? line : `${line.trimEnd()} ${VICTOR_MARK}`);
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
  const kept = mode === "replace" ? body.filter(isVictors) : body;
  return [...all.slice(0, start + 1), ...kept, ...lines, ...tail, ...all.slice(end)].join("\n") + "\n";
}

/** Adds to or replaces one section. The bot's writes are capped and can't mark lines as the user's. */
function writeMemory(home, { section, text, mode }, { now, by = "bot" }) {
  const name = redactSecrets(String(section ?? ""))
    .replace(/\s+/g, " ")
    .replace(/^#+\s*/, "")
    .trim();
  if (!name) return Promise.reject(new Error("A memory section needs a name."));
  const lines = redactSecrets(String(text ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => (by === "victor" ? markLine(line) : unmarked(line)));
  return serial(home, async () => {
    const previous = await readText(home);
    const next = edit(previous, name, lines, mode === "replace" ? "replace" : "append");
    if (by !== "victor") checkCaps(previous, next);
    return commit(home, previous, next, now);
  });
}

/** The user's whole-file save from the profile: every line that isn't in the stored text becomes theirs. */
function saveMemoryByVictor(home, text, { now }) {
  return serial(home, async () => {
    const previous = await readText(home);
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

module.exports = { VICTOR_MARK, readMemory, redactSecrets, saveMemoryByVictor, undoMemory, writeMemory };
