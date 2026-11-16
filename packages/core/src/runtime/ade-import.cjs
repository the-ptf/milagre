const fs = require("node:fs");
const os = require("node:os");
const { scanSources } = require("../ade-import/sources.cjs");
const { readTranscript, transcriptIndex } = require("../ade-import/transcripts.cjs");
const { addImportedChats, importedIds, worktreeFor } = require("../ade-import/import.cjs");

const SKIP_REASONS = {
  "already-imported": "Already in Milagre",
  "no-worktree": "Its folder is no longer there. Restore it, then import again",
  unsupported: "Milagre doesn't support this agent, so it can't be imported",
  "no-session": "It never started, so there's nothing to bring",
  "no-project": "Its folder is no longer there. Restore it, then import again",
  "no-transcript": "Its conversation isn't on this computer. Import it on the computer where it ran",
};

const supported = (thread) => Boolean(thread.provider && thread.nativeId);
const realPath = (folder) => {
  try {
    return fs.realpathSync(folder);
  } catch {
    return folder;
  }
};
const unsupportedReason = (thread, transcripts) =>
  !thread.provider ? "unsupported" : !thread.nativeId ? "no-session" : transcripts.has(thread.provider, thread.nativeId) ? null : "no-transcript";

function registerAdeImport({ commands, emit, openProject, editProject, projectRegistry, projectStateReadOnly, options = {} }) {
  const scanOptions = options.adeImport ?? {};
  const scan = () => scanSources({ env: process.env, home: os.homedir(), ...scanOptions });

  const registeredPaths = async () => new Set((await projectRegistry().list()).map((project) => realPath(project.path)));

  async function knownIds(projectPath, registered) {
    if (!registered.has(realPath(projectPath))) return new Set();
    try {
      return importedIds((await projectStateReadOnly(realPath(projectPath))) ?? {});
    } catch {
      return new Set();
    }
  }

  commands.handle("import:scan", async () => {
    const registered = await registeredPaths();
    const transcripts = transcriptIndex({ env: process.env, home: os.homedir(), ...scanOptions });
    const sources = [];
    for (const source of scan()) {
      const projects = [];
      for (const project of source.projects) {
        const ids = await knownIds(project.path, registered);
        projects.push({
          ...project,
          exists: fs.existsSync(project.path),
          registered: registered.has(realPath(project.path)),
          threads: project.threads.map((thread) => {
            const imported = ids.has(thread.id) || Boolean(thread.nativeId && ids.has(`native:${thread.nativeId}`));
            const unsupported = imported ? null : unsupportedReason(thread, transcripts);
            return { ...thread, imported, ...(unsupported ? { unsupported } : {}) };
          }),
        });
      }
      sources.push({ ...source, projects });
    }
    return { sources };
  });

  commands.handle("import:run", async (_event, request) => {
    const wantedProjects = new Set(Array.isArray(request?.projects) ? request.projects.filter((item) => typeof item === "string") : []);
    const wantedThreads = new Set(Array.isArray(request?.threads) ? request.threads.filter((item) => typeof item === "string") : []);
    if (!wantedProjects.size && !wantedThreads.size) throw new Error("Choose at least one Project or thread to import.");
    const result = { projects: [], chats: 0, skipped: [] };
    const before = await registeredPaths();
    const skip = (title, reason) => result.skipped.push({ title, reason, message: SKIP_REASONS[reason] ?? reason });
    for (const source of scan()) {
      for (const project of source.projects) {
        const threads = project.threads.filter((thread) => wantedThreads.has(thread.id));
        if (!wantedProjects.has(`${source.id}:${project.path}`) && !threads.length) continue;
        if (!fs.existsSync(project.path)) {
          skip(project.name, "no-project");
          continue;
        }
        const opened = await openProject(project.path, { takeNotice: false, focus: false });
        result.projects.push({ path: opened.path, name: opened.name, source: source.id, added: !before.has(realPath(opened.path)) });
        const chats = [];
        for (const thread of threads) {
          if (!supported(thread)) {
            skip(thread.title, thread.provider ? "no-session" : "unsupported");
            continue;
          }
          const { file, messages } = await readTranscript(thread.provider, thread.nativeId, { env: process.env, home: os.homedir(), ...scanOptions });
          chats.push({ ...thread, source: source.id, cwd: thread.cwd ?? project.path, messages, missing: !file });
        }
        if (!chats.length) continue;
        let outcome = { added: [], skipped: [] };
        await editProject(opened.path, (state) => {
          const placed = chats.map((chat) => ({ ...chat, worktreeId: worktreeFor(state, chat.cwd)?.id ?? null }));
          outcome = addImportedChats(state, placed);
          return outcome.state;
        });
        result.chats += outcome.added.length;
        for (const item of outcome.skipped) skip(chats.find((chat) => chat.id === item.id)?.title ?? item.id, item.reason);
      }
    }
    if (result.projects.length) emit("local-mcp:changed", { projectAdded: true });
    return result;
  });
}

module.exports = { registerAdeImport, SKIP_REASONS };
