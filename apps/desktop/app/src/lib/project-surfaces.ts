import { isChatsHomeProject, NO_PROJECT_LABEL } from "@milagre/shared/chats-home";

export type ProjectSurfaces = { git: boolean; settings: boolean; name: string };

export function projectSurfaces(project: { name: string; git?: boolean; kind?: string } | null | undefined): ProjectSurfaces {
  if (!project) return { git: true, settings: true, name: "" };
  if (isChatsHomeProject(project)) return { git: false, settings: false, name: NO_PROJECT_LABEL };
  return { git: project.git !== false, settings: true, name: project.name };
}
