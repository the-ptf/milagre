import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import type { ProjectKind } from "@milagre/shared/chats-home";

/** A project in the recent list, as the main process keeps it (most recent first). */
/** `hidden`: kept out of the all-Projects sidebar and the phone's Projects list. */
/** `origin`: the Git remote as "host/owner/repo", which ties the copies of one repository on several computers together. */
export type RecentProject = { path: string; name: string; openedAt: string; hidden?: boolean; origin?: string };

/** One project row in the project menu. */
export type ProjectRow = { path: string; name: string; initial: string; current: boolean };

/** The letter shown for a project without an avatar. */
export function projectInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "M";
}

function folderName(projectPath: string): string {
  return projectPath.split("/").findLast(Boolean) ?? projectPath;
}

/**
 * The project menu's rows: the recent list in its order, with the open project checked. The open project is
 * always a row, first when the list doesn't have it (a plain folder isn't listed, or the list hasn't loaded).
 */
export function projectRows({ recent, currentPath, currentName }: { recent: RecentProject[]; currentPath: string; currentName?: string }): ProjectRow[] {
  const listed = recent.some((project) => project.path === currentPath);
  const projects = listed ? recent : [{ path: currentPath, name: currentName ?? folderName(currentPath), openedAt: "" }, ...recent];
  const seen = new Set<string>();
  return projects.flatMap((project) => {
    if (seen.has(project.path)) return [];
    seen.add(project.path);
    return [{ path: project.path, name: project.name, initial: projectInitial(project.name), current: project.path === currentPath }];
  });
}

/**
 * The Project a new Chat starts in: always one of this Mac's. The open Project when it is this Mac's (a Link on screen
 * keeps the Project behind it), else this Mac's most recent one, a hidden one only when there is no other. Null when
 * this Mac has none. The Chats home is never it: only No project starts a Chat there, and the home is never recent.
 */
export function newChatProject({
  currentPath,
  currentKind,
  recent,
}: {
  currentPath: string | undefined;
  currentKind?: ProjectKind;
  recent: RecentProject[];
}): string | null {
  if (currentPath && currentKind !== "chats" && computerOfKey(currentPath) === LOCAL_COMPUTER) return currentPath;
  const local = recent.filter((project) => computerOfKey(project.path) === LOCAL_COMPUTER);
  return (local.find((project) => !project.hidden) ?? local[0])?.path ?? null;
}

export { stableOrder } from "@milagre/shared/stable-order";

/** Fired on window after a project is hidden or shown again, so lists read from the main process refresh. */
export const RECENT_PROJECTS_CHANGED = "milagre:recent-projects-changed";

/** A Project was removed from the list; close its current view without stopping its Chats. */
export const PROJECT_REMOVED = "milagre:project-removed";
