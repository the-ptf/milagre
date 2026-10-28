import { isChatsHomeProject, NO_PROJECT_LABEL } from "@milagre/shared/chats-home";

/**
 * What the window shows for the open Project. A Chat without a Project runs in the Chats home, an internal Git repository:
 * to the user it has no Git, no Project settings, no canvas entry and no Project name. A plain folder (`git: false`) has
 * no Git either, but is still a Project.
 */
export type ProjectSurfaces = { git: boolean; settings: boolean; canvas: boolean; name: string };

export function projectSurfaces(project: { name: string; git?: boolean; kind?: string } | null | undefined): ProjectSurfaces {
  if (!project) return { git: true, settings: true, canvas: true, name: "" };
  if (isChatsHomeProject(project)) return { git: false, settings: false, canvas: false, name: NO_PROJECT_LABEL };
  return { git: project.git !== false, settings: true, canvas: true, name: project.name };
}
