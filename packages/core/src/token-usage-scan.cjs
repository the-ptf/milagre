// Token usage read from the agent CLIs' own transcripts: Claude Code's projects/**/*.jsonl and Codex's
// sessions/**/*.jsonl. Each file is read once and then only from where the last scan stopped, so a scan after the first
// costs a stat per file. What a file held stays in the cache after the CLI deletes it (Claude keeps 30 days by default).
const fs = require("node:fs");
const path = require("node:path");

const CACHE_VERSION = 3;
const HOUR = 3_600_000;
// Rows older than this leave the cache; the page shows at most 90 days.
const KEEP_MS = 400 * 24 * HOUR;
const CHUNK = 4 * 1024 * 1024;
const NEWLINE = 10;
// Lines worth parsing. Everything else (tool output, prompts, file snapshots) is skipped without JSON.parse.
// Claude Code's ai-title and custom-title lines name its sessions too. (Codex writes no title of its own.)
const CLAUDE_MARKERS = [Buffer.from('"type":"assistant"'), Buffer.from('"type":"ai-title"'), Buffer.from('"type":"custom-title"')];
const CODEX_MARKERS = [Buffer.from('"token_count"'), Buffer.from('"type":"turn_context"'), Buffer.from('"type":"session_meta"')];
const TITLE_LENGTH = 80;

/** A title on one line: tags and their blocks dropped, whitespace folded, cut short. */
function promptTitle(text) {
  if (typeof text !== "string") return "";
  const line = text
    .replace(/<([a-z_-]+)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
}

const number = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const hourOf = (timestamp) => {
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? null : Math.floor(at / HOUR);
};

/** One request's tokens, split the way prices are: uncached input, cache reads, cache writes, output (reasoning is part of output). */
function addRow(entry, hour, model, session, counts) {
  const key = `${hour}\t${model}\t${session}`;
  const row = (entry.rows[key] ??= [0, 0, 0, 0, 0, 0]);
  row[0] += counts.input;
  row[1] += counts.cacheRead;
  row[2] += counts.cacheWrite;
  row[3] += counts.output;
  row[4] += counts.reasoning;
  row[5] += 1;
}

// Claude Code writes one line per content block, each repeating the message's usage: a message counts once, by its id
// and request id. A forked session copies earlier lines into a new file; those few repeats are left in.
function claudeLine(entry, line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (parsed?.type === "ai-title" || parsed?.type === "custom-title") {
    const title = promptTitle(parsed.customTitle ?? parsed.aiTitle);
    const session = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    if (!title || !session) return;
    const known = (entry.sessions[session] ??= { cwd: "" });
    // A title the user gave wins over the generated one.
    if (parsed.type === "custom-title" || !known.custom) known.title = title;
    if (parsed.type === "custom-title") known.custom = true;
    return;
  }
  if (parsed?.type !== "assistant" || !parsed.message?.usage) return;
  const { message } = parsed;
  const key = `${message.id ?? ""}:${parsed.requestId ?? ""}`;
  if (key !== ":" && entry.carry.recent?.includes(key)) return;
  entry.carry.recent = [...(entry.carry.recent ?? []).slice(-15), key];
  const model = typeof message.model === "string" ? message.model : "";
  if (!model || model === "<synthetic>") return;
  const hour = hourOf(parsed.timestamp);
  if (hour === null) return;
  const usage = message.usage;
  const counts = {
    input: number(usage.input_tokens),
    cacheRead: number(usage.cache_read_input_tokens),
    cacheWrite: number(usage.cache_creation_input_tokens),
    output: number(usage.output_tokens),
    reasoning: number(usage.output_tokens_details?.thinking_tokens),
  };
  if (!counts.input && !counts.cacheRead && !counts.cacheWrite && !counts.output) return;
  const session = typeof parsed.sessionId === "string" ? parsed.sessionId : entry.carry.session;
  if (session) {
    const known = (entry.sessions[session] ??= { cwd: "" });
    if (!known.cwd && typeof parsed.cwd === "string") known.cwd = parsed.cwd;
    // Milagre runs Claude Code through its SDK; a person at the terminal is "cli".
    if (known.milagre === undefined && typeof parsed.entrypoint === "string") known.milagre = parsed.entrypoint.startsWith("sdk");
  }
  addRow(entry, hour, model, session ?? "", counts);
}

// Codex reports each request as a token_count event: `last_token_usage` is that request, `total_token_usage` the thread's
// running total. Input includes cached input. A forked or subagent thread starts with its parent's session_meta, and an
// event whose total doesn't move is a repeat.
function codexLine(entry, line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const payload = parsed?.payload;
  if (!payload) return;
  const carry = entry.carry;
  if (parsed.type === "session_meta") {
    // The file's own thread is the first session_meta; later ones describe the thread it forked from.
    if (carry.thread) return;
    carry.thread = typeof payload.id === "string" ? payload.id : "";
    const parent = payload.source?.subagent?.thread_spawn?.parent_thread_id;
    carry.session = typeof parent === "string" && parent ? parent : carry.thread;
    carry.cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    carry.startedAt = Date.parse(parsed.timestamp) || 0;
    if (carry.session && !entry.sessions[carry.session]) entry.sessions[carry.session] = { cwd: carry.cwd, milagre: payload.originator === "milagre" };
    return;
  }
  if (parsed.type === "turn_context") {
    if (typeof payload.model === "string" && payload.model) carry.model = payload.model;
    return;
  }
  if (parsed.type !== "event_msg" || payload.type !== "token_count" || !payload.info) return;
  const at = Date.parse(parsed.timestamp);
  if (Number.isNaN(at) || (carry.startedAt && at < carry.startedAt)) return;
  const total = number(payload.info.total_token_usage?.total_tokens);
  if (total && total <= (carry.total ?? 0)) return;
  if (total) carry.total = total;
  const last = payload.info.last_token_usage;
  if (!last || !carry.model) return;
  const cacheRead = number(last.cached_input_tokens);
  const cacheWrite = number(last.cache_write_input_tokens);
  const counts = {
    input: Math.max(0, number(last.input_tokens) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: number(last.output_tokens),
    reasoning: number(last.reasoning_output_tokens),
  };
  if (!counts.input && !counts.cacheRead && !counts.cacheWrite && !counts.output) return;
  addRow(entry, Math.floor(at / HOUR), carry.model, carry.session ?? "", counts);
}

const PARSERS = { claude: { markers: CLAUDE_MARKERS, line: claudeLine }, codex: { markers: CODEX_MARKERS, line: codexLine } };

/**
 * Feeds each complete line of `buffer` that holds a marker to the provider's parser. Finding markers is native; each
 * marker's next position is kept until passed, so a rare marker isn't searched for again across the whole buffer.
 */
function readLines(buffer, provider, entry) {
  const { markers, line } = PARSERS[provider];
  const next = markers.map((marker) => buffer.indexOf(marker));
  let from = 0;
  while (from < buffer.length) {
    let at = -1;
    for (let i = 0; i < markers.length; i++) {
      if (next[i] !== -1 && next[i] < from) next[i] = buffer.indexOf(markers[i], from);
      if (next[i] !== -1 && (at === -1 || next[i] < at)) at = next[i];
    }
    if (at === -1) return;
    const start = buffer.lastIndexOf(NEWLINE, at) + 1;
    let end = buffer.indexOf(NEWLINE, at);
    if (end === -1) end = buffer.length;
    line(entry, buffer.toString("utf8", start, end));
    from = end + 1;
  }
}

/** Reads `entry.file` from `entry.offset` to its last complete line, yielding to the event loop between chunks. */
async function readFrom(entry, provider, size) {
  const handle = await fs.promises.open(entry.file, "r");
  try {
    let position = entry.offset;
    let pending = Buffer.alloc(0);
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      // `buffer` starts at entry.offset: the unread tail of the last chunk, then this one.
      const buffer = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const last = buffer.lastIndexOf(NEWLINE);
      if (last === -1) {
        pending = Buffer.from(buffer);
        continue;
      }
      readLines(buffer.subarray(0, last + 1), provider, entry);
      entry.offset += last + 1;
      pending = Buffer.from(buffer.subarray(last + 1));
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await handle.close();
  }
}

async function walk(directory, depth, found) {
  let children;
  try {
    children = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    const full = path.join(directory, child.name);
    if (child.isDirectory()) {
      if (depth > 0) await walk(full, depth - 1, found);
    } else if (child.isFile() && child.name.endsWith(".jsonl")) {
      found.push(full);
    }
  }
}

/**
 * Every transcript under the roots, each once. A file's identity doesn't change when the CLI moves it: Claude's is its
 * path under projects/, Codex's its file name (the thread id), so an archived Codex session keeps its cache entry.
 */
async function listFiles(roots) {
  const files = new Map();
  const seen = new Set();
  for (const { provider, dir } of roots) {
    let real;
    try {
      real = await fs.promises.realpath(dir);
    } catch {
      continue;
    }
    if (seen.has(`${provider}:${real}`)) continue;
    seen.add(`${provider}:${real}`);
    const found = [];
    await walk(real, 5, found);
    for (const file of found) {
      const id = provider === "claude" ? `claude:${path.relative(real, file)}` : `codex:${path.basename(file)}`;
      if (!files.has(id)) files.set(id, { provider, file });
    }
  }
  return files;
}

function emptyCache() {
  return { version: CACHE_VERSION, files: {} };
}

function loadCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed?.version === CACHE_VERSION && parsed.files && typeof parsed.files === "object" ? parsed : emptyCache();
  } catch {
    return emptyCache();
  }
}

function pruneRows(entry, now) {
  const oldest = Math.floor((now - KEEP_MS) / HOUR);
  for (const key of Object.keys(entry.rows)) {
    if (Number(key.slice(0, key.indexOf("\t"))) < oldest) delete entry.rows[key];
  }
}

/**
 * The scan over the CLIs' transcripts and its cache file. `scan()` reads what changed since the last one (one runs at a
 * time; callers share it). `rows()` flattens the cache for a report.
 */
function createTokenUsageScan({ cacheFile, roots, now = Date.now }) {
  let cache = null;
  let running = null;
  let scannedAt = 0;
  let writing = Promise.resolve();

  const ensure = () => (cache ??= cacheFile ? loadCache(cacheFile) : emptyCache());

  function persist() {
    if (!cacheFile) return writing;
    const body = JSON.stringify(cache);
    writing = writing
      .then(async () => {
        await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
        const temp = `${cacheFile}.tmp`;
        await fs.promises.writeFile(temp, body);
        await fs.promises.rename(temp, cacheFile);
      })
      .catch((error) => console.warn("Milagre couldn't save the token usage cache:", error.message));
    return writing;
  }

  async function run() {
    ensure();
    const files = await listFiles(await roots());
    let changed = false;
    for (const [id, { provider, file }] of files) {
      let stats;
      try {
        stats = await fs.promises.stat(file);
      } catch {
        continue;
      }
      let entry = cache.files[id];
      // A file that shrank was rewritten: read it again from the start.
      if (entry && stats.size < entry.offset) entry = null;
      if (entry && entry.file === file && entry.offset === stats.size) continue;
      entry ??= { provider, offset: 0, carry: {}, sessions: {}, rows: {} };
      entry.file = file;
      cache.files[id] = entry;
      if (entry.offset < stats.size) {
        try {
          await readFrom(entry, provider, stats.size);
        } catch (error) {
          if (error.code !== "ENOENT") console.warn("Milagre couldn't read a transcript for token usage:", error.message);
        }
      }
      pruneRows(entry, now());
      changed = true;
    }
    scannedAt = now();
    if (!cache.finishedAt) changed = true;
    cache.finishedAt = scannedAt;
    if (changed) await persist();
    return changed;
  }

  return {
    /** Reads what changed. Resolves to whether anything did. */
    scan() {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    scanning: () => running !== null,
    scannedAt: () => scannedAt,
    /** Whether a scan ever finished, here or in an earlier run of the app (its cache file). */
    finished: () => Boolean(ensure().finishedAt),
    /**
     * Every row: { provider, hour, model, session, cwd, title, milagre, input, cacheRead, cacheWrite, output, reasoning,
     * requests }. `milagre` marks a session Milagre started (Claude Code's SDK entrypoint, Codex's "milagre" originator).
     */
    rows() {
      const out = [];
      // A session's title can sit in another file than its usage (a Claude subagent's file has none).
      const titles = new Map();
      const fromMilagre = new Set();
      for (const entry of Object.values(ensure().files)) {
        for (const [session, known] of Object.entries(entry.sessions)) {
          if (known.title && !titles.has(session)) titles.set(session, known.title);
          if (known.milagre) fromMilagre.add(session);
        }
      }
      for (const entry of Object.values(ensure().files)) {
        for (const [key, row] of Object.entries(entry.rows)) {
          const [hour, model, session] = key.split("\t");
          out.push({
            provider: entry.provider,
            hour: Number(hour),
            model,
            session,
            cwd: entry.sessions[session]?.cwd ?? "",
            title: titles.get(session) ?? "",
            milagre: fromMilagre.has(session),
            input: row[0],
            cacheRead: row[1],
            cacheWrite: row[2],
            output: row[3],
            reasoning: row[4],
            requests: row[5],
          });
        }
      }
      return out;
    },
    idle: () => Promise.all([running, writing]),
  };
}

module.exports = { createTokenUsageScan, listFiles, HOUR };
