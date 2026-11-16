import type { Isolation } from "../model";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type ProjectChoice = { worktreePath?: string; baseBranch?: string };
type Preferences = ProjectChoice & { isolation: Isolation };
const KEY = "milagre.chat-preferences";

function read(storage: Storage) {
  try {
    return JSON.parse(storage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function loadChatPreferences(storage: Storage, projectPath: string): Preferences {
  const saved = read(storage);
  const project = saved.projects?.[projectPath];
  return {
    isolation: saved.isolation === "worktree" ? "worktree" : "local",
    ...(typeof project?.worktreePath === "string" ? { worktreePath: project.worktreePath } : {}),
    ...(typeof project?.baseBranch === "string" ? { baseBranch: project.baseBranch } : {}),
  };
}

export function saveChatPreferences(storage: Storage, projectPath: string, patch: Partial<Preferences>) {
  const saved = read(storage);
  const { isolation, ...choice } = patch;
  const { isolation: previousIsolation, ...previousChoice } = loadChatPreferences(storage, projectPath);
  try {
    storage.setItem(
      KEY,
      JSON.stringify({
        isolation: isolation ?? previousIsolation,
        projects: { ...saved.projects, [projectPath]: { ...previousChoice, ...choice } },
      }),
    );
  } catch {}
}
