import type { ModelProvider } from "./model.ts";

export type ImportSource = "t3code" | "paseo" | "orca";

/** Kept on an imported Chat's AgentSession as `importedFrom`: where it came from and the thread's id there, so a second import skips it. */
export type ImportedFrom = { source: ImportSource; id: string };

export type ImportThread = {
  id: string;
  title: string;
  provider: ModelProvider | null;
  sourceProvider: string | null;
  nativeId: string | null;
  cwd: string | null;
  branch: string | null;
  model?: string;
  archived: boolean;
  createdAt?: number;
  updatedAt?: number;
  imported: boolean;
  /** Why it can't come over: Milagre doesn't run its agent, or it never started a conversation. */
  unsupported?: "unsupported" | "no-session" | "no-transcript";
};

export type ImportProject = {
  name: string;
  path: string;
  exists: boolean;
  registered: boolean;
  archived?: boolean;
  /** Orca only: how many worktrees it lists for the repo. */
  worktrees?: number;
  threads: ImportThread[];
};

export type ImportSourceScan = {
  id: ImportSource;
  label: string;
  found: boolean;
  location: string | null;
  projects: ImportProject[];
  error?: string;
};

export type ImportScan = { sources: ImportSourceScan[] };

export type ImportRequest = { projects: string[]; threads: string[] };

export type ImportResult = {
  /** Every Project the import touched; `added` when it wasn't in Milagre before. */
  projects: { path: string; name: string; source: ImportSource; added?: boolean }[];
  chats: number;
  skipped: { title: string; reason: string; message: string }[];
};

export const IMPORT_TITLE = "Import from another app";
export const IMPORT_INTRO =
  "Bring Projects and ongoing Chats from T3 Code, Paseo or Orca. Imported Chats keep their history and pick up the same agent conversation.";
export const IMPORT_NONE = "Milagre didn't find T3 Code, Paseo or Orca data on this computer.";
export const UNSUPPORTED_LABEL: Record<NonNullable<ImportThread["unsupported"]>, string> = {
  unsupported: "Milagre doesn't support this agent, so it can't be imported",
  "no-session": "It never started, so there's nothing to bring",
  "no-transcript": "Its conversation isn't on this computer. Import it on the computer where it ran",
};

const listOf = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

/** The dialog's intro, naming only the apps this computer has data from. */
export function importIntro(scan: ImportScan | null | undefined) {
  const names = foundSources(scan).map((source) => source.label);
  return names.length
    ? `Bring Projects and ongoing Chats from ${listOf(names)}. Imported Chats keep their history and pick up the same agent conversation.`
    : IMPORT_INTRO;
}

export const projectKey = (source: ImportSource, project: Pick<ImportProject, "path">) => `${source}:${project.path}`;

export const importable = (thread: ImportThread) => !thread.imported && !thread.unsupported;

/** What a fresh scan preselects: every Project not yet in Milagre and its importable threads that aren't archived. */
export function defaultSelection(scan: ImportScan): ImportRequest {
  const projects: string[] = [];
  const threads: string[] = [];
  for (const source of scan.sources)
    for (const project of source.projects) {
      if (!project.exists) continue;
      const open = project.threads.filter((thread) => importable(thread) && !thread.archived);
      if (!project.registered || open.length) projects.push(projectKey(source.id, project));
      threads.push(...open.map((thread) => thread.id));
    }
  return { projects, threads };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The line after an import, naming what came in: Chats into their Projects, else the Projects that are new, else nothing. */
export function importSummary(result: ImportResult) {
  const names = (projects: ImportResult["projects"]) => [...new Map(projects.map((project) => [project.path, project.name])).values()];
  const touched = names(result.projects);
  const added = names(result.projects.filter((project) => project.added !== false));
  const what = (list: string[]) => (list.length === 1 ? list[0] : count(list.length, "Project"));
  const lead = result.chats
    ? `Imported ${count(result.chats, "Chat")} into ${what(touched)}.`
    : added.length
      ? `Imported ${what(added)}.`
      : "Nothing new to import.";
  const already = result.skipped.filter((item) => item.reason === "already-imported").length;
  const other = result.skipped.length - already;
  return [lead, ...(already ? [`${count(already, "Chat")} already in Milagre.`] : []), ...(other ? [`${other} skipped.`] : [])].join(" ");
}

export const foundSources = (scan: ImportScan | null | undefined) => (scan?.sources ?? []).filter((source) => source.found && source.projects.length);

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", claudeAgent: "Claude", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };

/** A thread's second line: its agent, branch and why it can't come over. */
export function threadDetail(thread: ImportThread) {
  const agent = PROVIDER_LABEL[thread.provider ?? thread.sourceProvider ?? ""] ?? thread.sourceProvider ?? "Unknown agent";
  const state = thread.imported ? "Already in Milagre" : thread.unsupported ? UNSUPPORTED_LABEL[thread.unsupported] : thread.archived ? "Archived" : null;
  return [agent, thread.branch, state].filter(Boolean).join(" · ");
}

export function projectDetail(project: ImportProject) {
  if (!project.exists) return "Its folder is no longer there. Restore it, then import again";
  const open = project.threads.filter(importable).length;
  const parts = [project.registered ? "Already in Milagre" : null];
  if (project.worktrees) parts.push(`${project.worktrees} ${project.worktrees === 1 ? "worktree" : "worktrees"}`);
  const imported = project.threads.filter((thread) => thread.imported).length;
  const chats = (n: number) => `${n} ${n === 1 ? "Chat" : "Chats"}`;
  if (open) parts.push(`${open} of ${chats(project.threads.length)} can come over`);
  if (imported) parts.push(`${imported} of ${chats(project.threads.length)} already in Milagre`);
  return parts.filter(Boolean).join(" · ") || project.path;
}

export function projectState(selection: ImportRequest, source: ImportSource, project: ImportProject): boolean | "indeterminate" {
  const key = projectKey(source, project);
  const open = project.threads.filter(importable);
  const picked = open.filter((thread) => selection.threads.includes(thread.id)).length;
  if (!selection.projects.includes(key)) return picked ? "indeterminate" : false;
  return picked === open.length ? true : "indeterminate";
}

export function toggleProject(selection: ImportRequest, source: ImportSource, project: ImportProject, on: boolean): ImportRequest {
  const key = projectKey(source, project);
  const ids = new Set(project.threads.filter(importable).map((thread) => thread.id));
  const threads = selection.threads.filter((id) => !ids.has(id));
  const projects = selection.projects.filter((item) => item !== key);
  return on ? { projects: [...projects, key], threads: [...threads, ...ids] } : { projects, threads };
}

export function toggleThread(selection: ImportRequest, source: ImportSource, project: ImportProject, thread: ImportThread, on: boolean): ImportRequest {
  const key = projectKey(source, project);
  const threads = selection.threads.filter((id) => id !== thread.id);
  if (!on) return { ...selection, threads };
  return { projects: selection.projects.includes(key) ? selection.projects : [...selection.projects, key], threads: [...threads, thread.id] };
}

export function importLabel(selection: ImportRequest) {
  const chats = selection.threads.length;
  if (chats) return `Import ${chats} ${chats === 1 ? "Chat" : "Chats"}`;
  const projects = selection.projects.length;
  return projects ? `Import ${projects} ${projects === 1 ? "Project" : "Projects"}` : "Import";
}

/** "T3 Code and Paseo: 3 Projects, 12 Chats", for the onboarding banner. */
export function foundLine(scan: ImportScan | null | undefined) {
  const sources = foundSources(scan);
  if (!sources.length) return null;
  const projects = sources.reduce((total, source) => total + source.projects.filter((project) => project.exists).length, 0);
  const chats = sources.reduce(
    (total, source) =>
      total + source.projects.reduce((sum, project) => sum + project.threads.filter((thread) => importable(thread) && !thread.archived).length, 0),
    0,
  );
  const label = listOf(sources.map((source) => source.label));
  const counts = [`${projects} ${projects === 1 ? "Project" : "Projects"}`, ...(chats ? [`${chats} ${chats === 1 ? "Chat" : "Chats"}`] : [])].join(" and ");
  return { title: `Bring your work from ${label}`, detail: `${counts} ready to import` };
}

/** After an import: everything that didn't come over, with why and what to do: what the import skipped, and what the scan already said can't come over. */
export function stayedBehind(result: ImportResult, scan?: ImportScan | null) {
  const lines = result.skipped.filter((item) => item.reason !== "already-imported").map((item) => ({ title: item.title, why: item.message }));
  const seen = new Set(lines.map((line) => line.title));
  for (const source of foundSources(scan))
    for (const project of source.projects) {
      if (!project.exists && !seen.has(project.name)) lines.push({ title: project.name, why: projectDetail(project) });
      for (const thread of project.exists ? project.threads : [])
        if (thread.unsupported && !seen.has(thread.title)) lines.push({ title: thread.title, why: UNSUPPORTED_LABEL[thread.unsupported] });
    }
  return lines;
}
