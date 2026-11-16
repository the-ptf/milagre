const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
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
    for (const agent of session.subagents) {
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
      const name = `${hash}.json`;
      const last = agent.transcript.at(-1);
      const refs = [...new Set([...(agent.transcriptFiles ?? []), agent.transcriptFile].filter((ref) => ref && ref !== name))];
      subagents.push({
        ...agent,
        transcriptFile: name,
        ...(refs.length ? { transcriptFiles: refs } : {}),
        transcript: [{ ...last, text: last.text.slice(-1000), compact: true }],
      });
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

async function hydrateSubagents(projectPath, state) {
  const validName = (name) => typeof name === "string" && SIDECAR.test(name);
  let resolved;
  const directoryOf = () => (resolved ??= contentDirectory(projectPath, "subagents"));
  const tasks = [];
  for (const session of Object.values(state.sessions ?? {})) {
    for (const agent of session.subagents ?? []) {
      const refs = [...new Set([...(agent.transcriptFiles ?? []), agent.transcriptFile].filter(validName))];
      if (refs.length) tasks.push({ agent, refs });
    }
  }
  const hydrate = async ({ agent, refs }) => {
    const entries = new Map();
    const missing = [];
    const merge = (rows) => {
      for (const row of rows) if (!row.compact || !entries.has(row.id)) entries.set(row.id, row);
    };
    for (const ref of refs) {
      try {
        const directory = await directoryOf();
        const file = await fs.realpath(path.join(directory, ref));
        if (!inside(directory, file)) throw new Error("Invalid transcript path");
        const bytes = await fs.readFile(file);
        if (digest(bytes) + ".json" !== ref) throw new Error("Invalid transcript hash");
        const transcript = JSON.parse(bytes);
        if (
          !Array.isArray(transcript) ||
          !transcript.every((row) => typeof row.id === "string" && typeof row.text === "string" && ["message", "tool"].includes(row.kind))
        )
          throw new Error("Invalid transcript");
        merge(transcript);
      } catch {
        missing.push(ref);
      }
    }
    merge(agent.transcript ?? []);
    agent.transcript = [...entries.values()];
    delete agent.transcriptFile;
    if (missing.length) agent.transcriptFiles = missing;
    else delete agent.transcriptFiles;
  };
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(HYDRATE_CONCURRENCY, tasks.length) }, async () => {
      while (cursor < tasks.length) await hydrate(tasks[cursor++]);
    }),
  );
  return state;
}
module.exports = {
  storeImages,
  migrateImages,
  compactSubagents,
  hydrateSubagents,
  referencedSidecars,
  sweepSubagentContent,
  compactDetails,
  withDetails,
  restoreDetails,
  referencedDetails,
  sweepDetailContent,
  INLINE_DETAIL,
};
