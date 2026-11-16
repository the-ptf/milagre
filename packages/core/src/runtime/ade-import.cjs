const fs = require("node:fs");
const os = require("node:os");
const { scanSources } = require("../ade-import/sources.cjs");
const { readTranscript, transcriptIndex } = require("../ade-import/transcripts.cjs");
const { addImportedChats, importedIds, worktreeFor } = require("../ade-import/import.cjs");

const SKIP_REASONS = {
  "already-imported": "Already in Milagre",
  "no-worktree": "Its folder is no longer there",
  unsupported: "Milagre doesn't run this agent",
  "no-session": "It never started a conversation",
  "no-project": "Its Project folder is no longer there",
  "no-transcript": "Its conversation isn't on this computer",
};

const supported = (thread) => Boolean(thread.provider && thread.nativeId);
const unsupportedReason = (thread, transcripts) =>
  !thread.provider ? "unsupported" : !thread.nativeId ? "no-session" : transcripts.has(thread.provider, thread.nativeId) ? null : "no-transcript";

function registerAdeImport({ commands, openProject, editProject, known, projectStateReadOnly, options = {} }) {
  const scanOptions = options.adeImport ?? {};
  const scan = () => scanSources({ env: process.env, home: os.homedir(), ...scanOptions });

  async function knownIds(projectPath, registered) {
    if (!registered.has(projectPath)) return new Set();
    try {
      return importedIds((await projectStateReadOnly(projectPath)) ?? {});
    } catch {
      return new Set();
    }
  }

  commands.handle("import:scan", async () => {
    const registered = new Set((await known().list()).map((project) => project.path));
    const transcripts = transcriptIndex({ env: process.env, home: os.homedir(), ...scanOptions });
    const sources = [];
    for (const source of scan()) {
      const projects = [];
      for (const project of source.projects) {
        const ids = await knownIds(project.path, registered);
        projects.push({
          ...project,
          exists: fs.existsSync(project.path),
          registered: registered.has(project.path),
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
        result.projects.push({ path: opened.path, name: opened.name, source: source.id });
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
    return result;
  });
}

module.exports = { registerAdeImport, SKIP_REASONS };
