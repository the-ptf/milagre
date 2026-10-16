const { createGit } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const client = createGit().read;
const git = client.text;

// Lines a worktree adds and removes against the commit it branched from, uncommitted and untracked
// files included: what the chat's hover card shows. Read in the background and cached in the
// project state, so the card never waits on git.

const UNTRACKED_FILE_LIMIT = 500;
const UNTRACKED_SIZE_LIMIT = 1024 * 1024;
// Milagre's own state lives in the project, and isn't the chat's work even where it isn't ignored.
const PATHSPEC = ["--", ".", ":(exclude).milagre"];

/** Same recorded/default comparison branch as Changes and the commit dialog. */
async function diffBase(cwd, base) {
  return (await client.chatBase(cwd, base)).ref ?? "HEAD";
}

// chatBase is up to eight git processes and its answer rarely changes, while every agent step
// re-reads the stat; remember it per (cwd, base) for a short while.
const BASE_TTL = 30_000;
const baseCache = new Map();
async function cachedDiffBase(cwd, base, now = Date.now) {
  const key = `${cwd}\0${base ?? ""}`;
  const hit = baseCache.get(key);
  if (hit && now() - hit.at < BASE_TTL) return hit.ref;
  const ref = await diffBase(cwd, base);
  if (baseCache.size >= 200) baseCache.delete(baseCache.keys().next().value);
  baseCache.set(key, { ref, at: now() });
  return ref;
}

function sumNumstat(output) {
  let added = 0;
  let removed = 0;
  for (const line of output.split("\n")) {
    // Binary files report "-\t-".
    const [plus, minus] = line.split("\t");
    if (/^\d+$/.test(plus)) added += Number(plus);
    if (/^\d+$/.test(minus)) removed += Number(minus);
  }
  return { added, removed };
}

/** Lines in an untracked file; 0 for an empty, binary, very large or unreadable one. */
async function fileLineCount(fullPath) {
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > UNTRACKED_SIZE_LIMIT) return 0;
    const contents = await fs.readFile(fullPath);
    if (contents.includes(0)) return 0;
    const text = contents.toString("utf8");
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

// Per worktree: each untracked file's line count with the size and mtime it was counted at. A file
// whose stat hasn't moved isn't read again, so a settled worktree costs one ls-files and a stat per
// file instead of up to 500 reads; one an agent is still editing is re-counted.
const untrackedCache = new Map();
async function untrackedLines(cwd) {
  const files = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...PATHSPEC])).split("\0").filter(Boolean).slice(0, UNTRACKED_FILE_LIMIT);
  const known = untrackedCache.get(cwd);
  const counted = new Map();
  let lines = 0;
  for (const file of files) {
    const full = path.join(cwd, file);
    const stat = await fs.stat(full).catch(() => null);
    const before = known?.get(file);
    const entry =
      stat && before && before.size === stat.size && before.mtimeMs === stat.mtimeMs
        ? before
        : { size: stat?.size, mtimeMs: stat?.mtimeMs, lines: await fileLineCount(full) };
    counted.set(file, entry);
    lines += entry.lines;
  }
  if (!known && untrackedCache.size >= 200) untrackedCache.delete(untrackedCache.keys().next().value);
  untrackedCache.set(cwd, counted);
  return lines;
}

/** `{ added, removed }` for the worktree at `cwd` against `base`, or null outside a repository. */
async function readDiffStat(cwd, base) {
  try {
    const ref = await cachedDiffBase(cwd, base);
    const mergeBase = ref === "HEAD" ? "HEAD" : (await git(cwd, ["merge-base", ref, "HEAD"])).trim();
    const tracked = sumNumstat(await git(cwd, ["diff", "--numstat", mergeBase, ...PATHSPEC]));
    return { added: tracked.added + (await untrackedLines(cwd)), removed: tracked.removed };
  } catch {
    return null;
  }
}

module.exports = { PATHSPEC, BASE_TTL, cachedDiffBase, diffBase, fileLineCount, readDiffStat };
