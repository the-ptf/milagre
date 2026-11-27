const path = require("node:path");
const { projectOfKey } = require("@milagre/shared/agent-runs");

function createBugReportsForRuntime({
  chats,
  isClosing,
  options,
  dataDir,
  version,
  projectRegistry,
  recentProjects,
  scopeStates,
  projectOrigin,
  remoteComputers,
}) {
  const os = require("node:os");
  const reports = require("../bug-reports.cjs");
  const override = process.env.MILAGRE_BUG_REPORT_REPO;
  const { providerName } = require("@milagre/shared/providers");
  let osLine;
  return reports.createBugReports({
    send: (chatId, event) => chats.receive(chatId, event),
    active: (chatId) => Boolean(chats.runs[chatId]) && !isClosing(),
    ...(override && /^[\w.-]+\/[\w.-]+$/.test(override) ? { repo: override } : {}),
    ...(options.postBugReport ? { post: options.postBugReport } : {}),
    readLog: () => reports.readHostLog(path.join(dataDir, "daemon.log")),
    async facts(chatId) {
      const turn = chats.turns.get(chatId);
      osLine ??= reports.osDescription();
      return {
        version,
        os: await osLine,
        ...(turn?.provider ? { provider: providerName(turn.provider) } : {}),
        ...(typeof turn?.model === "string" ? { model: turn.model } : {}),
        ...(turn?.effort ? { effort: turn.effort } : {}),
        ...(turn?.permissionMode ? { permissionMode: turn.permissionMode } : {}),
        ...(turn?.guard?.level ? { babysit: turn.guard.level } : {}),
      };
    },
    async known(chatId) {
      const projectPath = projectOfKey(chatId);
      const quiet = (promise, fallback, ms = 3000) =>
        Promise.race([Promise.resolve(promise).catch(() => fallback), new Promise((resolve) => setTimeout(resolve, ms, fallback).unref?.())]);
      const [registered, recent, state] = await Promise.all([
        quiet(
          projectRegistry()
            .snapshot()
            .then((snapshot) => snapshot.projects),
          [],
        ),
        quiet(recentProjects().list(), []),
        quiet(scopeStates.has(projectPath) ? scopeStates.get(projectPath) : null, null),
      ]);
      const projects = [...registered, ...recent, { path: projectPath }]
        .filter((project) => typeof project?.path === "string" && path.isAbsolute(project.path))
        .slice(0, 200);
      const withOrigin = await Promise.all(projects.map(async (project) => ({ ...project, origin: await quiet(projectOrigin(project.path), null) })));
      const identity = path.isAbsolute(projectPath) ? await quiet(reports.gitIdentity(projectPath), {}) : {};
      return reports.knownValues({
        projects: withOrigin,
        state,
        computers: [options.hostNetwork?.().name, ...quietList(() => remoteComputers()?.list() ?? []).map((computer) => computer?.name)],
        hostname: os.hostname(),
        home: os.homedir(),
        username: quietList(() => [os.userInfo().username])[0],
        gitName: identity.name,
        gitEmail: identity.email,
      });
    },
  });
}
function quietList(read) {
  try {
    return read();
  } catch {
    return [];
  }
}

module.exports = { createBugReportsForRuntime };
