const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let sqlite;
function sqliteModule() {
  if (!sqlite) {
    const emit = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      if (String(warning?.message ?? warning).includes("SQLite is an experimental feature")) return;
      return emit.call(process, warning, ...rest);
    };
    try {
      sqlite = require("node:sqlite");
    } finally {
      process.emitWarning = emit;
    }
  }
  return sqlite;
}

function withSnapshot(file, read) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-import-"));
  try {
    const copy = path.join(folder, "state.sqlite");
    fs.copyFileSync(file, copy);
    if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
    const db = new (sqliteModule().DatabaseSync)(copy);
    try {
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

const tableNames = (db) =>
  new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );

function json(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const list = (value, ...keys) => {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  if (value && typeof value === "object") for (const key of keys) if (value[key] && typeof value[key] === "object") return Object.values(value[key]);
  return [];
};

const time = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

const T3_PROVIDERS = { claudeAgent: "claude", claude: "claude", codex: "codex" };
const PASEO_PROVIDERS = { claude: "claude", codex: "codex" };

function group(projects, threads) {
  const byId = new Map(projects.map((project) => [project.id, { ...project, threads: [] }]));
  for (const thread of threads) byId.get(thread.projectId)?.threads.push(thread);
  return [...byId.values()].map(({ id: _id, ...project }) => ({
    ...project,
    threads: project.threads.map(({ projectId: _projectId, ...thread }) => thread).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
  }));
}

function t3Thread(row, extra) {
  return {
    projectId: row.project_id,
    id: `t3code:${row.thread_id}`,
    title: String(row.title || "").trim() || "Untitled thread",
    archived: Boolean(row.archived_at),
    createdAt: time(row.created_at),
    updatedAt: time(row.updated_at),
    ...extra,
  };
}

function t3V2(db) {
  const projects = db
    .prepare("SELECT project_id, title, workspace_root, archived_at FROM projection_projects WHERE deleted_at IS NULL")
    .all()
    .map((row) => ({ id: row.project_id, name: row.title, path: row.workspace_root, archived: Boolean(row.archived_at) }));
  const rows = db
    .prepare(
      `SELECT t.*, p.payload_json AS provider_payload, p.driver AS provider_driver
       FROM orchestration_v2_projection_threads t
       LEFT JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = t.active_provider_thread_id
       WHERE t.deleted_at IS NULL`,
    )
    .all();
  const threads = [];
  for (const row of rows) {
    const payload = json(row.payload_json) ?? {};
    if (payload.lineage?.relationshipToParent === "subagent") continue;
    const providerPayload = json(row.provider_payload) ?? {};
    const sourceProvider = providerPayload.driver ?? row.provider_driver ?? row.default_provider;
    threads.push(
      t3Thread(row, {
        sourceProvider,
        provider: T3_PROVIDERS[sourceProvider] ?? null,
        nativeId: providerPayload.nativeThreadRef?.nativeId ?? null,
        cwd: payload.worktreePath ?? null,
        branch: payload.branch ?? null,
        model: payload.modelSelection?.model,
      }),
    );
  }
  return { projects, threads };
}

function t3Stable(db, tables) {
  const projects = db
    .prepare("SELECT * FROM projection_projects WHERE deleted_at IS NULL")
    .all()
    .map((row) => ({ id: row.project_id, name: row.title, path: row.workspace_root, archived: Boolean(row.archived_at) }));
  const sessions = new Map(
    tables.has("projection_thread_sessions")
      ? db
          .prepare("SELECT * FROM projection_thread_sessions")
          .all()
          .map((row) => [row.thread_id, row])
      : [],
  );
  const runtimes = new Map(
    tables.has("provider_session_runtime")
      ? db
          .prepare("SELECT * FROM provider_session_runtime")
          .all()
          .map((row) => [row.thread_id, row])
      : [],
  );
  const threads = db
    .prepare("SELECT * FROM projection_threads WHERE deleted_at IS NULL")
    .all()
    .map((row) => {
      const session = sessions.get(row.thread_id);
      const runtime = runtimes.get(row.thread_id);
      const sourceProvider = runtime?.provider_name ?? session?.provider_name ?? json(row.model_selection_json)?.instanceId ?? null;
      const provider = T3_PROVIDERS[sourceProvider] ?? null;
      const cursor = json(runtime?.resume_cursor_json) ?? {};
      const nativeId = provider === "claude" ? (cursor.resume ?? null) : provider === "codex" ? (cursor.threadId ?? session?.provider_thread_id ?? null) : null;
      return t3Thread(row, {
        sourceProvider,
        provider,
        nativeId,
        cwd: row.worktree_path ?? null,
        branch: row.branch ?? null,
        model: json(row.model_selection_json)?.model ?? row.model ?? undefined,
      });
    });
  return { projects, threads };
}

function scanT3Code({ env, home }) {
  const root = env.T3CODE_HOME || path.join(home, ".t3");
  const file = ["statev2.sqlite", "state.sqlite"].map((name) => path.join(root, "userdata", name)).find((candidate) => fs.existsSync(candidate));
  if (!file) return { found: false };
  return {
    found: true,
    location: file,
    projects: withSnapshot(file, (db) => {
      const tables = tableNames(db);
      if (!tables.has("projection_projects")) return [];
      const { projects, threads } = tables.has("orchestration_v2_projection_threads") ? t3V2(db) : t3Stable(db, tables);
      return group(projects, threads);
    }),
  };
}

function paseoAgents(root) {
  const folder = path.join(root, "agents");
  const agents = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return agents;
  }
  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(folder, dir.name)).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of files) {
      const agent = readJson(path.join(folder, dir.name, name));
      if (agent && typeof agent === "object" && !agent.internal && !agent.background) agents.push(agent);
    }
  }
  return agents;
}

const inside = (child, parent) => {
  if (!child || !parent) return false;
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

function scanPaseo({ env, home }) {
  const root = env.PASEO_HOME || path.join(home, ".paseo");
  const projectsFile = path.join(root, "projects", "projects.json");
  const agentsFolder = path.join(root, "agents");
  if (!fs.existsSync(projectsFile) && !fs.existsSync(agentsFolder)) return { found: false };
  const projects = list(readJson(projectsFile), "projects", "items")
    .filter((project) => project?.rootPath && !project.archivedAt)
    .map((project) => ({
      id: project.projectId ?? project.id ?? project.rootPath,
      name: project.customName ?? project.displayName ?? path.basename(project.rootPath),
      path: project.rootPath,
    }));
  const workspaces = list(readJson(path.join(root, "projects", "workspaces.json")), "workspaces", "items");
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.workspaceId ?? workspace.id, workspace]));
  const threads = [];
  for (const agent of paseoAgents(root)) {
    const workspace = workspaceById.get(agent.workspaceId);
    const cwd = agent.cwd ?? workspace?.cwd;
    const projectId = workspace?.projectId ?? projects.filter((project) => inside(cwd, project.path)).sort((a, b) => b.path.length - a.path.length)[0]?.id;
    if (!projectId || !agent.id) continue;
    threads.push({
      projectId,
      id: `paseo:${agent.id}`,
      title: String(agent.title || "").trim() || "Untitled agent",
      sourceProvider: agent.provider ?? null,
      provider: PASEO_PROVIDERS[agent.provider] ?? null,
      nativeId: agent.persistence?.sessionId ?? agent.persistence?.nativeHandle ?? agent.runtimeInfo?.sessionId ?? null,
      cwd: cwd ?? null,
      branch: workspace?.branch ?? null,
      model: agent.config?.model ?? agent.runtimeInfo?.model,
      archived: Boolean(agent.archivedAt),
      createdAt: time(agent.createdAt),
      updatedAt: time(agent.lastActivityAt ?? agent.updatedAt),
    });
  }
  return { found: true, location: root, projects: group(projects, threads) };
}

function orcaUserData({ env, home, platform }) {
  const bases =
    platform === "darwin"
      ? [path.join(home, "Library", "Application Support")]
      : platform === "win32"
        ? [env.APPDATA || path.join(home, "AppData", "Roaming")]
        : [env.XDG_CONFIG_HOME || path.join(home, ".config")];
  return bases.flatMap((base) => ["Orca", "orca"].map((name) => path.join(base, name)));
}

function orcaState(folder) {
  const profiles = path.join(folder, "profiles");
  let ids = [];
  try {
    ids = fs
      .readdirSync(profiles, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {}
  ids.sort((a, b) => (a === "local-default" ? -1 : b === "local-default" ? 1 : a.localeCompare(b)));
  for (const id of ids) {
    const file = path.join(profiles, id, "profile-state.db");
    if (!fs.existsSync(file)) continue;
    const state = withSnapshot(file, (db) => {
      if (!tableNames(db).has("profile_state_documents")) return null;
      const result = {};
      for (const row of db.prepare("SELECT domain, payload FROM profile_state_documents").all()) result[row.domain] = json(row.payload);
      return result;
    });
    if (state) return { file, state };
  }
  for (const file of [path.join(folder, "orca-data.json"), ...ids.map((id) => path.join(profiles, id, "orca-data.json"))]) {
    const state = readJson(file);
    if (state) return { file, state };
  }
  return null;
}

function scanOrca(options) {
  for (const folder of orcaUserData(options)) {
    if (!fs.existsSync(folder)) continue;
    const found = orcaState(folder);
    if (!found) continue;
    const worktrees = Object.entries(found.state.worktreeMeta ?? {});
    const projects = list(found.state.repos, "repos")
      .filter((repo) => repo?.path)
      .map((repo) => ({
        name: repo.displayName || path.basename(repo.path),
        path: repo.path,
        worktrees: worktrees.filter(([id, meta]) => id.startsWith(`${repo.id}::`) && !meta?.isArchived).length,
        threads: [],
      }));
    return { found: true, location: found.file, projects };
  }
  return { found: false };
}

const SOURCES = [
  { id: "t3code", label: "T3 Code", scan: scanT3Code },
  { id: "paseo", label: "Paseo", scan: scanPaseo },
  { id: "orca", label: "Orca", scan: scanOrca },
];

function scanSources({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  return SOURCES.map((source) => {
    try {
      const result = source.scan({ env, home, platform });
      return { id: source.id, label: source.label, found: Boolean(result.found), location: result.location ?? null, projects: result.projects ?? [] };
    } catch (error) {
      return { id: source.id, label: source.label, found: true, location: null, projects: [], error: error.message };
    }
  });
}

module.exports = { scanSources, scanT3Code, scanPaseo, scanOrca };
