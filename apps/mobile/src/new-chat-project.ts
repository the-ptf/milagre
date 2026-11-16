import { NO_PROJECT_LABEL, type ChatsHome } from "@milagre/shared/chats-home";
import { groupByOrigin } from "@milagre/shared/project-origin";
import type { HostView } from "./all-computers-store";
import type { RecentProject, RegisteredProject } from "./client";

export type NewChatProject = { hostId: string; hostName: string; offline: boolean; path: string; name: string; origin?: string };
export type NewChatProjectGroup = NewChatProject & { computerId: string; copies: (NewChatProject & { computerId: string })[] };

type NoProjectCopy = { hostId: string; hostName: string; offline: boolean; home: ChatsHome };
export type NoProjectChoice = { kind: "no-project"; name: string; computerId: string; copies: NoProjectCopy[] };
export type NewChatChoice = NoProjectChoice | (NewChatProjectGroup & { kind: "project" });

export type NewChatLink = { hostId: string; hostName: string; offline: boolean; path: string; name: string; members: RegisteredProject[] };

export function newChatProjects(views: readonly HostView[], known?: ReadonlyMap<string, readonly RecentProject[]>): NewChatProject[] {
  return views.flatMap((view) =>
    withKnown(view.projects, known?.get(view.hostId)).flatMap((project) =>
      project.path === view.home?.path || project.link || project.path.startsWith("milagre-link:")
        ? []
        : [
            {
              hostId: view.hostId,
              hostName: view.name,
              offline: view.state === "offline",
              path: project.path,
              name: project.name || project.path.split("/").at(-1) || "Project",
              ...(project.origin ? { origin: project.origin } : {}),
            },
          ],
    ),
  );
}

export function newChatLinks(views: readonly HostView[], currentHostId: string | undefined): NewChatLink[] {
  const view = views.find((item) => item.hostId === currentHostId);
  if (!view) return [];
  return view.projects.flatMap((project) =>
    project.link && !project.link.canvasLinkId && !project.hidden
      ? [
          {
            hostId: view.hostId,
            hostName: view.name,
            offline: view.state === "offline",
            path: project.path,
            name: project.name || project.link.name || "Link",
            members: project.projects ?? [],
          },
        ]
      : [],
  );
}

function withKnown(recent: readonly RecentProject[], known: readonly RecentProject[] | undefined): readonly RecentProject[] {
  if (!known?.length) return recent;
  const listed = new Set(recent.map((project) => project.path));
  return [...recent, ...known.filter((project) => typeof project?.path === "string" && !listed.has(project.path))];
}

type Place = { hostId: string; projectPath: string } | null | undefined;

export function pickNewChatProject(projects: readonly NewChatProject[], last: Place, current: Place): NewChatProject | undefined {
  const reachable = projects.filter((project) => !project.offline);
  const find = (place: Place) => place && reachable.find((project) => project.hostId === place.hostId && project.path === place.projectPath);
  return find(last) || find(current) || reachable[0];
}

export function newChatProjectGroups(projects: readonly NewChatProject[]): NewChatProjectGroup[] {
  return groupByOrigin(projects.map((project) => ({ ...project, computerId: project.hostId })));
}

export function preferredCopy(group: NewChatProjectGroup, lastHostId: string | null, currentHostId: string): NewChatProject {
  const reachable = group.copies.filter((copy) => !copy.offline);
  return reachable.find((copy) => copy.hostId === lastHostId) ?? reachable.find((copy) => copy.hostId === currentHostId) ?? reachable[0] ?? group;
}

const UNREAD_HOME: ChatsHome = { path: "", exists: false };

export function noProjectChoice(views: readonly HostView[], lastHostId: string | null, currentHostId: string | undefined): NoProjectChoice | undefined {
  const copies = views.flatMap((view) => {
    const home = view.home === undefined && (view.state === "online" || view.hostId === currentHostId) ? UNREAD_HOME : view.home;
    return home ? [{ hostId: view.hostId, hostName: view.name, offline: view.state === "offline", home }] : [];
  });
  if (!copies.length) return undefined;
  const reachable = copies.filter((copy) => !copy.offline);
  const start = reachable.find((copy) => copy.hostId === lastHostId) ?? reachable.find((copy) => copy.hostId === currentHostId) ?? reachable[0] ?? copies[0]!;
  return { kind: "no-project", name: NO_PROJECT_LABEL, computerId: start.hostId, copies };
}

export function newChatChoices(views: readonly HostView[], lastHostId: string | null, currentHostId: string | undefined): NewChatChoice[] {
  const noProject = noProjectChoice(views, lastHostId, currentHostId);
  const groups = newChatProjectGroups(newChatProjects(views)).map((group): NewChatChoice => Object.assign(group, { kind: "project" as const }));
  return noProject ? [noProject, ...groups] : groups;
}
