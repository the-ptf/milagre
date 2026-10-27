import type { HostView } from "./all-computers-store";

/** A Project a new Chat can start in, on any shown computer. */
export type NewChatProject = { hostId: string; hostName: string; offline: boolean; path: string; name: string };

/** Every shown computer's Projects, including those hidden from the sidebar, in sidebar order. */
export function newChatProjects(views: readonly HostView[]): NewChatProject[] {
  return views.flatMap((view) =>
    view.projects.map((project) => ({
      hostId: view.hostId,
      hostName: view.name,
      offline: view.state === "offline",
      path: project.path,
      name: project.name || project.path.split("/").at(-1) || "Project",
    })),
  );
}

type Place = { hostId: string; projectPath: string } | null | undefined;

/**
 * Where New Chat opens: the Project the last new Chat started in, else the open Project, else the first one. A Project on
 * an offline computer is passed over for the next choice.
 */
export function pickNewChatProject(projects: readonly NewChatProject[], last: Place, current: Place): NewChatProject | undefined {
  const reachable = projects.filter((project) => !project.offline);
  const find = (place: Place) => place && reachable.find((project) => project.hostId === place.hostId && project.path === place.projectPath);
  return find(last) || find(current) || reachable[0];
}
