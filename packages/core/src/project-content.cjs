const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { TRANSCRIPT_TAIL, withTranscriptTail } = require("@milagre/shared/subagent-transcript");
const { subagentFinished } = require("@milagre/shared/project-edits");
const { decodeImages } = require("./image-input.cjs");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const SIDECAR = /^[a-f0-9]{64}\.json$/;

async function contentDirectory(projectPath, folder) {
  const root = await fs.realpath(projectPath);
  const metadata = path.join(root, ".milagre");
  await fs.mkdir(metadata, { recursive: true });
  if (!inside(root, await fs.realpath(metadata))) throw new Error("Project content directory is outside the Project");
  const directory = path.join(metadata, folder);
  await fs.mkdir(directory, { recursive: true });
  if (!inside(metadata, await fs.realpath(directory))) throw new Error("Project content directory is outside the Project");
  return directory;
}

async function writeContent(projectPath, folder, bytes, extension, resolved) {
  const directory = resolved ?? (await contentDirectory(projectPath, folder));
  const name = `${digest(bytes)}.${extension}`;
  const file = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const real = await fs.realpath(file);
      if (!inside(directory, real) || digest(await fs.readFile(real)) !== digest(bytes))
        throw new Error("Stored Project content does not match its reference", { cause: error });
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return file;
}

async function storeImages(projectPath, images = []) {
  const decoded = decodeImages(images);
  return Promise.all(
    images.map(async (image, index) => {
      const { bytes, mime } = decoded[index];
      const extension = mime === "image/jpeg" ? "jpg" : mime.slice("image/".length);
      const stored = await writeContent(projectPath, "images", bytes, extension);
      const { dataUrl: _dataUrl, path: uploaded, ...rest } = image;
      const original = typeof image.sourcePath === "string" && image.sourcePath ? image.sourcePath : uploaded;
      return { ...rest, path: stored, ...(original ? { sourcePath: original } : {}) };
    }),
  );
}

async function migrateImages(projectPath, state) {
  let changed = false;
  const messages = [];
  for (const message of state.messages ?? []) {
    if (!message.images?.some((image) => typeof image.dataUrl === "string")) {
      messages.push(message);
      continue;
    }
    const images = [];
    for (const image of message.images) {
      if (typeof image.dataUrl !== "string") {
        images.push(image);
        continue;
      }
      try {
        images.push((await storeImages(projectPath, [image]))[0]);
        changed = true;
      } catch {
        images.push(image);
      }
    }
    messages.push({ ...message, images });
  }
  return changed ? { ...state, messages } : state;
}

async function compactSubagents(projectPath, state, tracker = {}) {
  if (!state.sessions) return state;
  const { known, next } = tracker;
  let directory;
  let existing;
  const sessions = {};
  for (const [id, session] of Object.entries(state.sessions)) {
    if (!session.subagents?.length) {
      sessions[id] = session;
      continue;
    }
    const subagents = [];
    for (const held of session.subagents) {
      const stub = unloaded.get(held?.transcript);
      if (stub?.projectPath === projectPath) {
        const { transcriptLength: _length, transcriptFile: _file, transcriptFiles: _files, ...rest } = held;
        subagents.push({ ...rest, ...stub.saved, transcript: stub.rows });
        continue;
      }
      const agent = stub ? wholeAgent(held, loadTranscriptSync(held)) : held;
      if (!agent.transcript?.length) {
        subagents.push(agent);
        continue;
      }
      let bytes = null;
      let hash = transcriptDigests.get(agent.transcript);
      if (!hash) {
        bytes = JSON.stringify(agent.transcript);
        hash = digest(bytes);
        transcriptDigests.set(agent.transcript, hash);
      }
      const key = `${id}/${agent.id}`;
      if (known?.get(key) === hash) existing ??= new Set(await fs.readdir(path.join(projectPath, ".milagre", "subagents")).catch(() => []));
      if (known?.get(key) !== hash || !existing.has(`${hash}.json`)) {
        directory ??= await contentDirectory(projectPath, "subagents");
        await writeContent(projectPath, "subagents", (bytes ??= JSON.stringify(agent.transcript)), "json", directory);
        tracker.wrote = true;
      }
      next?.set(key, hash);
      subagents.push({ ...agent, ...savedRefs(agent, `${hash}.json`), transcript: [compactRow(agent.transcript.at(-1))] });
    }
    sessions[id] = { ...session, subagents };
  }
  return { ...state, sessions };
}

const INLINE_DETAIL = 1024;
const PR_COMMAND = /\bgh\s+pr\s+(create|merge)\b/;
const keepsDetail = (step, index, thought) =>
  step.detail.length <= INLINE_DETAIL || index === thought || (step.kind === "shell" && PR_COMMAND.test(step.detail));
const isDetails = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((detail) => typeof detail === "string");

async function readDetailFile(directory, name) {
  if (typeof name !== "string" || !SIDECAR.test(name)) throw new Error("Invalid details reference");
  const file = await fs.realpath(path.join(directory, name));
  if (!inside(directory, file)) throw new Error("Invalid details path");
  const bytes = await fs.readFile(file);
  if (digest(bytes) + ".json" !== name) throw new Error("Invalid details hash");
  const details = JSON.parse(bytes);
  if (!isDetails(details)) throw new Error("Invalid details");
  return details;
}

async function compactDetails(projectPath, state, { previous, tracker = {} } = {}) {
  const known = previous ? new Set(previous) : null;
  let directory;
  let changed = false;
  const messages = [];
  for (const message of state.messages ?? []) {
    const steps = known?.has(message) ? null : message.steps;
    const thought = steps?.findLastIndex((step) => step.kind === "thinking" && step.detail?.trim()) ?? -1;
    if (!steps?.some((step, index) => typeof step.detail === "string" && step.status !== "running" && !keepsDetail(step, index, thought))) {
      messages.push(message);
      continue;
    }
    directory ??= await contentDirectory(projectPath, "details");
    const details = message.detailFile ? await readDetailFile(directory, message.detailFile).catch(() => null) : {};
    if (!details) {
      messages.push(message);
      continue;
    }
    const slim = steps.map((step, index) => {
      if (typeof step.detail !== "string" || step.status === "running" || keepsDetail(step, index, thought)) return step;
      details[step.id] = step.detail;
      const { detail: _moved, ...rest } = step;
      return { ...rest, hasDetail: true };
    });
    const bytes = JSON.stringify(details);
    await writeContent(projectPath, "details", bytes, "json", directory);
    tracker.wrote = true;
    messages.push({ ...message, steps: slim, detailFile: `${digest(bytes)}.json` });
    changed = true;
  }
  return changed ? { ...state, messages } : state;
}

async function withDetails(projectPath, message) {
  if (!message?.detailFile) return message;
  let details;
  try {
    details = await readDetailFile(await contentDirectory(projectPath, "details"), message.detailFile);
  } catch {
    return message;
  }
  const { detailFile: _file, ...rest } = message;
  return {
    ...rest,
    steps: (message.steps ?? []).map(({ hasDetail, ...step }) =>
      typeof details[step.id] === "string" ? { ...step, detail: details[step.id] } : hasDetail ? { ...step, hasDetail } : step,
    ),
  };
}

async function restoreDetails(projectPath, state) {
  if (!state.messages?.some((message) => message.detailFile)) return state;
  return { ...state, messages: await Promise.all(state.messages.map((message) => withDetails(projectPath, message))) };
}

function referencedDetails(state) {
  return new Set((state.messages ?? []).map((message) => message.detailFile).filter((name) => typeof name === "string"));
}

const transcriptDigests = new WeakMap();

function referencedSidecars(state) {
  const refs = new Set();
  for (const session of Object.values(state.sessions ?? {}))
    for (const agent of session.subagents ?? [])
      for (const ref of [agent.transcriptFile, ...(agent.transcriptFiles ?? [])]) if (typeof ref === "string") refs.add(ref);
  return refs;
}

async function sweepSubagentContent(projectPath, referenced, options) {
  return sweepContent(projectPath, "subagents", referenced, options);
}

async function sweepDetailContent(projectPath, referenced, options) {
  return sweepContent(projectPath, "details", referenced, options);
}

async function sweepContent(projectPath, folder, referenced, { minAgeMs = 0, now = Date.now } = {}) {
  try {
    const root = await fs.realpath(projectPath);
    const metadata = path.join(root, ".milagre");
    const directory = path.join(metadata, folder);
    let real;
    try {
      real = await fs.realpath(directory);
    } catch {
      return 0;
    }
    if (real !== directory || !inside(root, await fs.realpath(metadata))) return 0;
    let removed = 0;
    for (const name of await fs.readdir(directory)) {
      if (!SIDECAR.test(name) || referenced.has(name)) continue;
      const file = path.join(directory, name);
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || now() - stat.mtimeMs < minAgeMs) continue;
      await fs.rm(file, { force: true });
      removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}

const HYDRATE_CONCURRENCY = 8;
const WHOLE_TTL_MS = 60 * 1000;
const unloaded = new WeakMap();
let wholeAgents = new WeakMap();
let wholeStates = new WeakMap();
let wholesUsedAt = 0;

const validRef = (name) => typeof name === "string" && SIDECAR.test(name);
const refsOf = (agent) => [...new Set([...(agent.transcriptFiles ?? []), agent.transcriptFile].filter(validRef))];
const compactRow = (row) => ({ ...row, text: row.text.slice(-1000), compact: true });

function savedRefs(agent, name) {
  const refs = [...new Set([...(agent.transcriptFiles ?? []), agent.transcriptFile].filter((ref) => ref && ref !== name))];
  return { transcriptFile: name, ...(refs.length ? { transcriptFiles: refs } : {}) };
}

function parseTranscript(bytes, ref) {
  if (digest(bytes) + ".json" !== ref) throw new Error("Invalid transcript hash");
  const transcript = JSON.parse(bytes);
  if (
    !Array.isArray(transcript) ||
    !transcript.every((row) => typeof row.id === "string" && typeof row.text === "string" && ["message", "tool"].includes(row.kind))
  )
    throw new Error("Invalid transcript");
  return transcript;
}

async function readTranscript(directory, ref) {
  const file = await fs.realpath(path.join(directory, ref));
  if (!inside(directory, file)) throw new Error("Invalid transcript path");
  return parseTranscript(await fs.readFile(file), ref);
}

function readTranscriptSync(projectPath, ref) {
  const root = fsSync.realpathSync(projectPath);
  const directory = fsSync.realpathSync(path.join(root, ".milagre", "subagents"));
  const file = fsSync.realpathSync(path.join(directory, ref));
  if (!inside(root, directory) || !inside(directory, file)) throw new Error("Invalid transcript path");
  return parseTranscript(fsSync.readFileSync(file), ref);
}

function union(parts, own) {
  const entries = new Map();
  for (const rows of [...parts, own ?? []]) for (const row of rows) if (!row.compact || !entries.has(row.id)) entries.set(row.id, row);
  return [...entries.values()];
}

const isUnloaded = (agent) => unloaded.has(agent?.transcript);

function wholeAgent(agent, transcript) {
  const { transcriptLength: _length, ...rest } = agent;
  return { ...rest, transcript };
}

function unload(agent, whole, stub) {
  const tail = whole.slice(-TRANSCRIPT_TAIL);
  unloaded.set(tail, stub);
  return { ...agent, transcript: tail, transcriptLength: whole.length };
}

async function hydrateSubagents(projectPath, state, { unloadFinished = false } = {}) {
  let resolved;
  const directoryOf = () => (resolved ??= contentDirectory(projectPath, "subagents"));
  const tasks = [];
  for (const session of Object.values(state.sessions ?? {})) {
    for (const [index, agent] of (session.subagents ?? []).entries()) {
      const refs = refsOf(agent);
      if (refs.length) tasks.push({ session, index, agent, refs });
    }
  }
  const hydrate = async ({ session, index, agent, refs }) => {
    const parts = [];
    const missing = [];
    for (const ref of refs) {
      try {
        parts.push(await readTranscript(await directoryOf(), ref));
      } catch {
        missing.push(ref);
      }
    }
    const rows = agent.transcript ?? [];
    agent.transcript = union(parts, rows);
    delete agent.transcriptFile;
    if (missing.length) agent.transcriptFiles = missing;
    else delete agent.transcriptFiles;
    if (unloadFinished && !missing.length && subagentFinished(agent) && agent.transcript.length > TRANSCRIPT_TAIL)
      session.subagents[index] = unload(agent, agent.transcript, { projectPath, saved: savedRefs({ transcriptFiles: refs }, refs.at(-1)), rows });
  };
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(HYDRATE_CONCURRENCY, tasks.length) }, async () => {
      while (cursor < tasks.length) await hydrate(tasks[cursor++]);
    }),
  );
  return state;
}

/** `agent` as it was before its transcript left memory: every entry, read back from its sidecars. */
async function loadSubagent(agent) {
  const stub = unloaded.get(agent?.transcript);
  if (!stub) return agent;
  const cached = wholeAgents.get(agent);
  if (cached) return cached;
  const parts = [];
  const directory = await contentDirectory(stub.projectPath, "subagents").catch(() => null);
  for (const ref of refsOf(stub.saved)) {
    const rows = directory && (await readTranscript(directory, ref).catch(() => null));
    if (rows) parts.push(rows);
  }
  return wholeAgent(agent, union(parts, stub.rows));
}

function loadTranscriptSync(agent) {
  const stub = unloaded.get(agent.transcript);
  const parts = [];
  for (const ref of refsOf(stub.saved)) {
    try {
      parts.push(readTranscriptSync(stub.projectPath, ref));
    } catch {}
  }
  return union(parts, stub.rows);
}

function wholeSubagent(agent) {
  let whole = wholeAgents.get(agent);
  if (!whole) wholeAgents.set(agent, (whole = wholeAgent(agent, loadTranscriptSync(agent))));
  return whole;
}

/** `state` with every subagent's whole transcript, for a reader that takes them all; the same object while it lasts. */
function withWholeTranscripts(state) {
  if (!state?.sessions || typeof state.sessions !== "object") return state;
  wholesUsedAt = Date.now();
  let whole = wholeStates.get(state);
  if (whole) return whole;
  let sessions;
  for (const [id, session] of Object.entries(state.sessions))
    if (session?.subagents?.some(isUnloaded))
      (sessions ??= { ...state.sessions })[id] = {
        ...session,
        subagents: session.subagents.map((agent) => (isUnloaded(agent) ? wholeSubagent(agent) : agent)),
      };
  whole = sessions ? { ...state, sessions } : state;
  wholeStates.set(state, whole);
  return whole;
}

function forgetWholeTranscripts(now = Date.now()) {
  if (now - wholesUsedAt < WHOLE_TTL_MS) return;
  wholeAgents = new WeakMap();
  wholeStates = new WeakMap();
}

async function withLoadedSubagent(state, sessionId, event) {
  const session = event.type === "subagent-update" ? state.sessions?.[sessionId] : undefined;
  const agent = session?.subagents?.find((item) => item.id === event.agent?.id);
  if (!isUnloaded(agent)) return state;
  const whole = await loadSubagent(agent);
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: { ...session, subagents: session.subagents.map((item) => (item === agent ? whole : item)) } },
  };
}

/** `state` with each finished subagent whose transcript `known` says the last save wrote ("chat/agent" to digest) held as its tail. */
function unloadSaved(projectPath, state, known) {
  if (!known?.size || !state?.sessions) return state;
  let sessions;
  for (const [id, session] of Object.entries(state.sessions)) {
    let subagents;
    for (const [index, agent] of (session?.subagents ?? []).entries()) {
      if (isUnloaded(agent) || agent.transcriptFiles || !subagentFinished(agent) || !(agent.transcript?.length > TRANSCRIPT_TAIL)) continue;
      const hash = transcriptDigests.get(agent.transcript);
      if (!hash || known.get(`${id}/${agent.id}`) !== hash) continue;
      const tail = withTranscriptTail(agent);
      unloaded.set(tail.transcript, { projectPath, saved: savedRefs(agent, `${hash}.json`), rows: [compactRow(agent.transcript.at(-1))] });
      (subagents ??= [...session.subagents])[index] = tail;
    }
    if (subagents) (sessions ??= { ...state.sessions })[id] = { ...session, subagents };
  }
  return sessions ? { ...state, sessions } : state;
}

module.exports = {
  storeImages,
  migrateImages,
  compactSubagents,
  hydrateSubagents,
  loadSubagent,
  withLoadedSubagent,
  withWholeTranscripts,
  forgetWholeTranscripts,
  unloadSaved,
  referencedSidecars,
  sweepSubagentContent,
  compactDetails,
  withDetails,
  restoreDetails,
  referencedDetails,
  sweepDetailContent,
  INLINE_DETAIL,
};
