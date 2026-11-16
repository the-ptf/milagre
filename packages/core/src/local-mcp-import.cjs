const { z } = require("zod");

/** import_scan's answer: each source that left data, its Projects (key, path, in Milagre) and threads. */
function scanSummary({ sources }) {
  return sources
    .filter((source) => source.found)
    .map(({ id, label, projects, error }) => ({
      source: id,
      label,
      ...(error ? { error } : {}),
      projects: projects.map((item) => ({
        key: `${id}:${item.path}`,
        name: item.name,
        path: item.path,
        exists: item.exists,
        inMilagre: item.registered,
        threads: item.threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          provider: thread.provider ?? thread.sourceProvider,
          archived: thread.archived,
          ...(thread.imported ? { imported: true } : {}),
          ...(thread.unsupported ? { unsupported: thread.unsupported } : {}),
        })),
      })),
    }));
}

/** import_scan and import_run for the projects tool group. `importer` is the host's scan, run, confirm and callerMode; absent, both refuse. */
function importTools({ importer, caller, assertActive, grant }) {
  const unavailable = () => {
    throw Error("Importing is unavailable");
  };
  return [
    {
      name: "import_scan",
      description:
        "List what T3 Code, Paseo and Orca left on this computer: their Projects (key, path, whether already in Milagre) and threads (id, title, agent, archived, imported, unsupported). Read-only.",
      input: {},
      readOnly: true,
      capability: "read",
      run: async () => {
        const result = scanSummary(await (importer?.scan ?? unavailable)());
        assertActive();
        return JSON.stringify(result);
      },
    },
    {
      name: "import_run",
      description:
        "Import Projects (keys from import_scan) and threads (ids from import_scan) from T3 Code, Paseo or Orca. Threads become Chats with their history that resume the same Claude or Codex conversation; already imported ones are skipped. Unless this Chat runs in Full permission, the user approves first on a card in this Chat: wait for its result, don't end the turn or move on.",
      input: { projects: z.array(z.string().min(1).max(8192)).max(200).default([]), threads: z.array(z.string().min(1).max(512)).max(1000).default([]) },
      readOnly: false,
      capability: "create",
      run: async ({ projects = [], threads = [] }) => {
        assertActive();
        if (!projects.length && !threads.length) throw Error("Name at least one Project key or thread id from import_scan.");
        if (!caller) throw Error("Importing from another app needs a Chat in Milagre to approve it.");
        if (!importer) unavailable();
        if ((await importer.callerMode(caller)) !== "full")
          await importer.confirm(caller, {
            title: "Import from another app into Milagre?",
            description: "Adds these Projects to Milagre and copies these threads in as Chats that resume the same agent conversation.",
            detail: JSON.stringify({ projects, threads }, null, 2),
          });
        const result = await importer.run({ projects, threads });
        for (const item of result.projects) grant(item.path);
        assertActive();
        return JSON.stringify(result);
      },
    },
  ];
}

module.exports = { importTools, scanSummary };
