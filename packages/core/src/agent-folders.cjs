const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { resolveProject } = require("./project-identity.cjs");

// Onboarding's "Where your agents worked recently": the folders Claude Code and Codex sessions on this Mac ran in,
// newest first, each read as the Project it would open as (a linked worktree lists as its repository). Only the
// start of each session file is read, and only the newest files, so a long history stays quick.
const HEAD_BYTES = 64 * 1024;
const MAX_FILES = 400;
const MAX_CANDIDATES = 120;

async function head(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

function cwdIn(text) {
  const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

async function newestFiles(files) {
  const stats = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, at: (await fs.stat(file)).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  return stats.filter(Boolean).sort((a, b) => b.at - a.at);
}

async function readdir(folder) {
  try {
    return await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Claude Code keeps one folder per working directory under projects/, each holding that directory's session files.
async function claudeSessions(home) {
  const root = path.join(home, "projects");
  const files = [];
  for (const entry of await readdir(root)) {
    if (!entry.isDirectory()) continue;
    const sessions = (await readdir(path.join(root, entry.name))).filter((item) => item.isFile() && item.name.endsWith(".jsonl"));
    const newest = (await newestFiles(sessions.map((item) => path.join(root, entry.name, item.name))))[0];
    if (newest) files.push(newest);
  }
  return files.map((item) => ({ ...item, provider: "claude" }));
}

// Codex files its sessions by date (sessions/YYYY/MM/DD), so the newest days are read first.
async function codexSessions(home) {
  const files = [];
  const descend = async (folder, depth) => {
    const entries = (await readdir(folder)).sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(folder, entry.name);
      if (depth < 3 && entry.isDirectory()) await descend(full, depth + 1);
      else if (depth === 3 && entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  await descend(path.join(home, "sessions"), 0);
  return (await newestFiles(files)).map((item) => ({ ...item, provider: "codex" }));
}

function nested(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function hidden(folder, homeDir, ignore) {
  const inside = (base) => {
    const relative = path.relative(base, folder);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  return folder === homeDir || folder === path.parse(folder).root || ignore.some(inside);
}

/** @returns {Promise<{ path: string, name: string, provider: "claude" | "codex", lastUsed: string, git: boolean }[]>} */
async function agentFolders({
  homeDir = os.homedir(),
  claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, ".claude"),
  codexHome = process.env.CODEX_HOME || path.join(homeDir, ".codex"),
  resolve = resolveProject,
  // Milagre's own Worktrees and Link folders, app data and scratch folders aren't anyone's project. The desktop check
  // (scripts/test-desktop.cjs) keeps scratch folders with MILAGRE_ONBOARDING_TEMP_FOLDERS=1, as its fixtures live there.
  ignore = [
    path.join(homeDir, "Library"),
    path.join(homeDir, ".milagre"),
    ...(process.env.MILAGRE_ONBOARDING_TEMP_FOLDERS === "1" ? [] : [os.tmpdir(), "/private/var", "/private/tmp", "/tmp"]),
  ],
  limit = 5,
} = {}) {
  const sessions = [...(await claudeSessions(claudeHome)), ...(await codexSessions(codexHome))].sort((a, b) => b.at - a.at);
  const seen = new Set();
  const candidates = [];
  for (const session of sessions) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const cwd = cwdIn(await head(session.file));
    if (!cwd || !path.isAbsolute(cwd) || seen.has(cwd)) continue;
    seen.add(cwd);
    // A Milagre Worktree under ~/.milagre still counts: it lists as its repository below.
    if (
      hidden(
        cwd,
        homeDir,
        ignore.filter((folder) => folder !== path.join(homeDir, ".milagre")),
      )
    )
      continue;
    candidates.push({ cwd, provider: session.provider, at: session.at });
  }
  const found = new Map();
  for (const candidate of candidates) {
    if (found.size >= limit) break;
    let project;
    try {
      project = await resolve(candidate.cwd);
    } catch {
      continue;
    }
    if (found.has(project.path) || hidden(project.path, homeDir, ignore)) continue;
    // Sessions in a folder and its subfolders (v1, v2, v3 of one piece of work) list once, at the newest.
    if (project.git === false && [...found.keys()].some((listed) => nested(listed, project.path) || nested(project.path, listed))) continue;
    found.set(project.path, {
      path: project.path,
      name: project.name,
      provider: candidate.provider,
      lastUsed: new Date(candidate.at).toISOString(),
      git: project.git !== false,
    });
  }
  return [...found.values()];
}

module.exports = { agentFolders };
