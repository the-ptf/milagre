import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import type { ProjectKind } from "@milagre/shared/chats-home";
import { projectInitial } from "@milagre/shared/project-list";

export type RecentProject = { path: string; name: string; openedAt: string; hidden?: boolean; origin?: string };

export type ProjectRow = { path: string; name: string; initial: string; current: boolean };

export { projectInitial };

function folderName(projectPath: string): string {
  return projectPath.split("/").findLast(Boolean) ?? projectPath;
}

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

export const RECENT_PROJECTS_CHANGED = "milagre:recent-projects-changed";

export const PROJECT_REMOVED = "milagre:project-removed";
