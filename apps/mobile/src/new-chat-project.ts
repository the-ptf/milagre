import { NO_PROJECT_LABEL, type ChatsHome } from "@milagre/shared/chats-home";
import { groupByOrigin } from "@milagre/shared/project-origin";
import type { HostView } from "./all-computers-store";

/** A Project a new Chat can start in, on any shown computer. */
export type NewChatProject = { hostId: string; hostName: string; offline: boolean; path: string; name: string; origin?: string };
/** One row of the new-chat Project picker: a Project and its copies on every computer that has the same repository. */
export type NewChatProjectGroup = NewChatProject & { computerId: string; copies: (NewChatProject & { computerId: string })[] };

/** A computer a Chat without a Project can start on, and its Chats home there (made on pick when it doesn't exist yet). */
export type NoProjectCopy = { hostId: string; hostName: string; offline: boolean; home: ChatsHome };
/** The picker's No project row: one for every computer, starting on `computerId` unless another is picked. */
export type NoProjectChoice = { kind: "no-project"; name: string; computerId: string; copies: NoProjectCopy[] };
/** One row of the new-chat picker: No project, or a Project with its copies. */
export type NewChatChoice = NoProjectChoice | (NewChatProjectGroup & { kind: "project" });

/** Every shown computer's Projects, including those hidden from the sidebar, in sidebar order. */
export function newChatProjects(views: readonly HostView[]): NewChatProject[] {
  return views.flatMap((view) =>
    view.projects
      .filter((project) => project.path !== view.home?.path)
      .map((project) => ({
        hostId: view.hostId,
        hostName: view.name,
        offline: view.state === "offline",
        path: project.path,
        name: project.name || project.path.split("/").at(-1) || "Project",
        ...(project.origin ? { origin: project.origin } : {}),
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

/** The Projects one row per repository: one Git origin on several computers is one row, in the place of its first copy. */
export function newChatProjectGroups(projects: readonly NewChatProject[]): NewChatProjectGroup[] {
  return groupByOrigin(projects.map((project) => ({ ...project, computerId: project.hostId })));
}

/** The copy a picked Project opens: on the computer last used for it, else the open one, else the first that answers. */
export function preferredCopy(group: NewChatProjectGroup, lastHostId: string | null, currentHostId: string): NewChatProject {
  const reachable = group.copies.filter((copy) => !copy.offline);
  return reachable.find((copy) => copy.hostId === lastHostId) ?? reachable.find((copy) => copy.hostId === currentHostId) ?? reachable[0] ?? group;
}

/**
 * The No project row: every shown computer whose daemon has a Chats home, on the computer the phone last started a Chat
 * on, else the open one, else the first that answers. Undefined while no computer has one (all older, or none read yet).
 */
export function noProjectChoice(views: readonly HostView[], lastHostId: string | null, currentHostId: string | undefined): NoProjectChoice | undefined {
  const copies = views.flatMap((view) => (view.home ? [{ hostId: view.hostId, hostName: view.name, offline: view.state === "offline", home: view.home }] : []));
  if (!copies.length) return undefined;
  const reachable = copies.filter((copy) => !copy.offline);
  const start = reachable.find((copy) => copy.hostId === lastHostId) ?? reachable.find((copy) => copy.hostId === currentHostId) ?? reachable[0] ?? copies[0]!;
  return { kind: "no-project", name: NO_PROJECT_LABEL, computerId: start.hostId, copies };
}

/** The new-chat picker's rows: No project first, then one row per repository. The Chats homes are never Project rows. */
export function newChatChoices(views: readonly HostView[], lastHostId: string | null, currentHostId: string | undefined): NewChatChoice[] {
  const noProject = noProjectChoice(views, lastHostId, currentHostId);
  const groups = newChatProjectGroups(newChatProjects(views)).map((group): NewChatChoice => Object.assign(group, { kind: "project" as const }));
  return noProject ? [noProject, ...groups] : groups;
}
