const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");

const MAX_HASHED = 50 * 1024 * 1024;
const IGNORED = /^\.milagre(\/|$)/;

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fileDigest(file) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return `link:${await fs.readlink(file)}`;
    if (stat.isDirectory()) return `dir`;
    if (stat.size > MAX_HASHED) return `big:${stat.size}:${stat.mtimeMs}`;
    return hash(await fs.readFile(file));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return "deleted";
    throw error;
  }
}

/**
 * The Worktree's code state: HEAD plus a digest of every file Git doesn't ignore that differs from it (tracked changes,
 * deletions and untracked files), leaving out Milagre's own `.milagre/`. Two states with the same digest hold the same code.
 */
async function codeState(git, cwd) {
  const head = await git.out(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const status = await git.checked(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  const paths = [
    ...new Set(
      status.stdout
        .split("\0")
        .filter((entry) => entry.length > 3)
        .map((entry) => entry.slice(3))
        .filter((name) => !IGNORED.test(name)),
    ),
  ].toSorted();
  const files = {};
  for (const name of paths) files[name] = await fileDigest(path.join(cwd, name));
  return { head: head || null, files, digest: hash(JSON.stringify([head || null, Object.entries(files)])) };
}

async function changedFiles(git, cwd, before, after) {
  const names = new Set();
  for (const name of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) if (before.files[name] !== after.files[name]) names.add(name);
  if (before.head && after.head && before.head !== after.head) {
    const diff = await git.run(cwd, ["diff", "--name-only", "-z", "--no-renames", before.head, after.head, "--"]);
    if (diff.ok)
      for (const name of diff.stdout.split("\0").filter(Boolean)) if (!IGNORED.test(name) && before.files[name] === after.files[name]) names.add(name);
  }
  return [...names].toSorted();
}

const codeSummary = (state) => ({ head: state.head, dirty: Object.keys(state.files).length, digest: state.digest });

/**
 * Changes a note Milagre wrote in a Chat, saved or still waiting for its turn to end: `match` picks it and `change`
 * returns the fields to replace. Resolves false when no note matches.
 */
async function updateChatNote(chats, chatId, match, change) {
  const waiting = chats.notes.get(chatId);
  if (waiting?.some(match)) {
    chats.notes.set(
      chatId,
      waiting.map((note) => (match(note) ? { ...note, ...change(note) } : note)),
    );
    return true;
  }
  const sessionId = sessionIdFromKey(chatId);
  let found = false;
  const { state, changed } = await chats.states.update(
    projectOfKey(chatId),
    (latest) => {
      const index = latest.messages.findLastIndex((message) => message.session_id === sessionId && match(message));
      if (index === -1) return latest;
      found = true;
      const messages = latest.messages.slice();
      messages[index] = { ...messages[index], ...change(messages[index]) };
      return { ...latest, messages };
    },
    { chats: [sessionId] },
  );
  if (changed) chats.broadcast(projectOfKey(chatId), state);
  return found;
}

/** The runs on disk: each run's owner and status, its logs, and the runs whose code state is still current. */
function createValidationStore(directory, { kept = 200 } = {}) {
  let fresh = null;
  let saving = Promise.resolve();
  const freshFile = path.join(directory, "fresh.json");
  const runFile = (runId) => path.join(directory, "runs", runId, "run.json");
  const logFile = (runId, index) => path.join(directory, "runs", runId, `${index}.log`);
  const validId = (runId) => typeof runId === "string" && /^[0-9a-f-]{36}$/.test(runId);
  const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8").catch(() => "null"));
  return {
    logFile,
    validId,
    async fresh() {
      if (fresh) return fresh;
      const parsed = await readJson(freshFile).catch(() => null);
      fresh = Array.isArray(parsed) ? parsed : [];
      return fresh;
    },
    setFresh(list) {
      fresh = list;
      const text = JSON.stringify(list);
      saving = saving
        .catch(() => {})
        .then(async () => {
          await fs.mkdir(directory, { recursive: true });
          const temporary = `${freshFile}.${process.pid}.tmp`;
          await fs.writeFile(temporary, text, { mode: 0o600 });
          await fs.rename(temporary, freshFile);
        });
      return saving;
    },
    async writeRun(runId, record) {
      await fs.mkdir(path.dirname(runFile(runId)), { recursive: true, mode: 0o700 });
      await fs.writeFile(runFile(runId), JSON.stringify(record), { mode: 0o600 });
    },
    readRun: (runId) => (validId(runId) ? readJson(runFile(runId)) : Promise.resolve(null)),
    async runIds() {
      return (await fs.readdir(path.join(directory, "runs")).catch(() => [])).filter(validId);
    },
    async prune(keep) {
      const root = path.join(directory, "runs");
      const names = await fs.readdir(root).catch(() => []);
      if (names.length <= kept) return;
      const dated = await Promise.all(names.map(async (name) => ({ name, at: (await fs.stat(path.join(root, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
      for (const { name } of dated.toSorted((a, b) => a.at - b.at).slice(0, names.length - kept))
        if (!keep.has(name)) await fs.rm(path.join(root, name), { recursive: true, force: true });
    },
  };
}

module.exports = { changedFiles, codeState, codeSummary, createValidationStore, updateChatNote };
