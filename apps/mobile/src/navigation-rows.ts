import { bySnoozedUntil } from "@milagre/shared/snooze";
import { searchMessages } from "@milagre/shared/message-search";
import { searchTrail } from "@milagre/shared/settings-search";
import { groupByOrigin } from "@milagre/shared/project-origin";
import { linkOwners, nestUnder, worktreeGroups, worktreeHeading } from "@milagre/shared/project-list";
import type { AgentSession } from "@milagre/shared/model";
import type { ChatList } from "@milagre/shared/chat-display";
import type { ChatSearchMatch } from "./client";
import { activityAgo } from "@milagre/shared/chat-row";
import { failedLines } from "@milagre/shared/message-search-view";
import type { HostHits } from "./host-search.ts";
import { SETTINGS_PAGES, searchPhoneSettings } from "./settings-index.ts";
import { chatsGroupChats, chatsGroupList } from "./chats-group.ts";
import { mergeChatLists } from "./chat-list-order.ts";
import { nestChatRows } from "./subchat-rows.ts";
import type { ChatEntry, ChatRow, HostBuild, HostTag, ProjectBuild, Row, SearchScope, Show } from "./navigation-build.ts";

export const TREE_INDENT = 16;
const SETTINGS_SHOWN = 6;

export type RowsInput = {
  builds: HostBuild[];
  chatList: ChatList;
  needle: string;
  show: Show;
  manyHosts: boolean;
  folds: ReadonlyMap<string, ReadonlySet<string>>;
  chatsFolded: boolean;
  doneOpen: boolean;
  snoozedOpen: boolean;
  subchatFolds: { has: (key: string) => boolean };
};

function chatRowFor(manyHosts: boolean) {
  return (build: HostBuild, project: ProjectBuild, entry: ChatEntry): ChatRow => ({
    key: `${build.hostId}|${project.path}#${entry.chat.id}`,
    path: project.path,
    kind: "chat",
    hostId: build.hostId,
    hostName: build.hostName,
    reach: build.reach,
    project: project.name,
    members: project.members,
    many: manyHosts,
    ...entry,
  });
}

function hostNotice(build: HostBuild): Row | null {
  const noData = !build.projects.some((project) => project.copy);
  if (build.reach !== "offline" && noData && (!build.loaded || build.projects.length))
    return {
      key: `notice:${build.hostId}`,
      path: "",
      kind: "notice",
      hostId: build.hostId,
      hostName: build.hostName,
      reach: build.reach,
      message: `Loading chats from ${build.hostName}...`,
    };
  return null;
}

function sharedProject(ctx: RowsInput, copies: { build: HostBuild; project: ProjectBuild }[]): Row[] {
  const { show, folds, manyHosts } = ctx;
  const chatRow = chatRowFor(manyHosts);
  if (show !== "all" && copies.every(({ project }) => project.copy && !project.chats.length && !project.failure)) return [];
  const head = copies.find(({ build }) => build.reach !== "offline") ?? copies[0]!;
  const open = !folds.get(head.build.hostId)?.has(head.project.path);
  const listed: Row[] = [
    {
      key: `${head.build.hostId}|${head.project.path}`,
      path: head.project.path,
      kind: "project",
      hostId: head.build.hostId,
      hostName: head.build.hostName,
      reach: copies.every(({ build }) => build.reach === "offline") ? "offline" : head.build.reach,
      name: head.project.name,
      expanded: open,
      members: head.project.members,
      link: head.project.link,
      chip: false,
      count: copies.reduce((sum, { project }) => sum + project.chats.length, 0),
    },
  ];
  if (!open) return listed;
  listed.push(
    ...mergeChatLists(
      copies.map(({ build, project }, rank) =>
        project.chats.map((entry) => ({
          rank,
          chat: entry.chat,
          row: { ...chatRow(build, project, entry), shared: true },
        })),
      ),
    ).map(({ row }) => row),
  );
  for (const { build, project } of copies) {
    if (build.reach === "offline" && (project.failure || !project.copy)) continue;
    const base = {
      path: project.path,
      kind: "notice" as const,
      hostId: build.hostId,
      hostName: build.hostName,
      reach: build.reach,
      retry: "project" as const,
    };
    if (project.failure)
      listed.push({
        ...base,
        key: `${build.hostId}|${project.path}:error`,
        message: `Could not ${project.copy ? "refresh" : "load"} chats on ${build.hostName}. Tap to retry.`,
        failed: true,
      });
    else if (!project.copy)
      listed.push({
        ...base,
        key: `${build.hostId}|${project.path}:notice`,
        message: `Loading chats from ${build.hostName}...`,
      });
  }
  if (listed.length === 1)
    listed.push({
      key: `${head.build.hostId}|${head.project.path}:notice`,
      path: head.project.path,
      kind: "notice",
      hostId: head.build.hostId,
      hostName: head.build.hostName,
      reach: head.build.reach,
      message:
        show !== "all"
          ? "No matching Chats"
          : copies.some(({ project }) => project.snoozed.length || project.done.length)
            ? "All caught up. Snoozed and Done Chats are below."
            : "No Chats yet. Start one with +.",
    });
  return listed;
}

function flatRows(ctx: RowsInput, result: Row[], found: SearchScope[], offlineLine: Row[]) {
  const { builds, needle, manyHosts } = ctx;
  const chatRow = chatRowFor(manyHosts);
  let rank = 0;
  const lists = builds.flatMap((build) =>
    build.projects.concat(build.home ? [build.home] : []).map((project) => {
      const mine = rank++;
      if (needle && project.copy)
        found.push({
          hostId: build.hostId,
          hostName: build.hostName,
          reach: build.reach,
          path: project.path,
          project: project.name,
          messages: project.copy.previewOnly || project.copy.project.state.messagesInChats ? null : project.copy.project.state.messages,
          chats: new Map(project.all.filter(({ pending }) => !pending).map(({ chat, title }) => [chat.id, { chat, title }])),
        });
      const home = project === build.home;
      return project.chats.map((entry) => ({
        rank: mine,
        chat: entry.chat,
        row: home ? { ...chatRow(build, project, entry), home } : chatRow(build, project, entry),
      }));
    }),
  );
  const chats = mergeChatLists(lists).map(({ row }) => row);
  if (needle && chats.length)
    result.push({
      key: "section:Chats",
      path: "",
      kind: "section",
      name: "Chats",
    });
  result.push(...chats);
  for (const build of builds) {
    const notice = hostNotice(build);
    if (notice) result.push(notice);
  }
  if (!needle) result.push(...offlineLine);
}

function groupedRows(ctx: RowsInput, result: Row[], chatsGroup: Row[], offlineLine: Row[]) {
  const { builds, chatList, show, manyHosts, folds } = ctx;
  const chatRow = chatRowFor(manyHosts);
  result.push(...chatsGroup);
  const shared = new Map<ProjectBuild, { build: HostBuild; project: ProjectBuild }[]>();
  for (const group of groupByOrigin(
    builds.flatMap((build) =>
      build.projects.map((project) => ({
        build,
        project,
        origin: project.origin,
        computerId: build.hostId,
      })),
    ),
  ))
    if (group.copies.length > 1) for (const copy of group.copies) shared.set(copy.project, group.copies);
  for (const build of builds) {
    const notice = build.projects.length ? null : hostNotice(build);
    if (notice) result.push(notice);
    const host = { hostId: build.hostId, hostName: build.hostName, reach: build.reach };
    const projectGroup = (project: ProjectBuild, member = false, hasMembers = false): Row[] => {
      const open = !folds.get(build.hostId)?.has(project.path);
      const indent = member ? TREE_INDENT : 0;
      const rows: Row[] = [
        {
          ...host,
          key: `${build.hostId}|${project.path}`,
          path: project.path,
          kind: "project",
          name: project.name,
          expanded: open,
          members: project.members,
          link: project.link,
          chip: manyHosts,
          count: project.chats.length,
          ...(member ? { member } : {}),
        },
      ];
      if (!open) return rows;
      if (chatList === "tree" && !project.link) {
        const state = project.copy?.project.state;
        for (const group of worktreeGroups({
          projectPath: project.path,
          worktrees: state ? Object.values(state.worktrees).map((worktree) => ({ path: worktree.path, name: worktree.name })) : [],
          rows: project.chats,
          pathOf: (entry) => entry.worktreePath,
          branchOf: (entry) => entry.worktree,
        })) {
          const heading = worktreeHeading(group);
          if (heading)
            rows.push({
              ...host,
              key: `${build.hostId}|${project.path}:worktree:${group.path}`,
              path: project.path,
              kind: "worktree",
              name: group.name,
              running: group.rows.some((entry) => entry.mark === "running"),
            });
          for (const entry of group.rows) rows.push({ ...chatRow(build, project, entry), indent: indent + (heading ? TREE_INDENT : 0) });
        }
      } else for (const entry of project.chats) rows.push(indent ? { ...chatRow(build, project, entry), indent } : chatRow(build, project, entry));
      const base = { ...host, path: project.path, kind: "notice" as const, retry: "project" as const };
      if (build.reach === "offline" && (project.failure || !project.copy)) return rows;
      if (project.failure)
        rows.push({
          ...base,
          key: `${build.hostId}|${project.path}:error`,
          message: project.copy ? "Could not refresh Chats. Tap to retry." : "Could not load Chats. Tap to retry.",
          failed: true,
        });
      else if (!project.copy || (!project.chats.length && !hasMembers && !member))
        rows.push({
          ...base,
          key: `${build.hostId}|${project.path}:notice`,
          message: !project.copy
            ? "Loading Chats..."
            : show !== "all"
              ? "No matching Chats"
              : project.snoozed.length || project.done.length
                ? "All caught up. Snoozed and Done Chats are below."
                : "No Chats yet. Start one with +.",
        });
      return rows;
    };
    const empty = (project: ProjectBuild) => show !== "all" && project.copy && !project.chats.length && !project.failure;
    const owners =
      chatList === "tree"
        ? linkOwners(
            build.projects.filter((project) => project.link).map((project) => ({ key: project.path, memberPaths: (project.members ?? []).map((m) => m.path) })),
          )
        : new Map<string, string>();
    for (const { item: project, children } of nestUnder(
      build.projects,
      (item) => item.path,
      (item) => (shared.has(item) ? undefined : owners.get(item.path)),
    )) {
      const copies = shared.get(project);
      if (copies) {
        if (copies[0]!.project === project) result.push(...sharedProject(ctx, copies));
        continue;
      }
      const members = children.filter((child) => !empty(child));
      if (empty(project) && !members.length) continue;
      result.push(...projectGroup(project, false, members.length > 0));
      if (!folds.get(build.hostId)?.has(project.path)) for (const child of members) result.push(...projectGroup(child, true));
    }
  }
  result.push(...offlineLine);
}

export function computeRows(ctx: RowsInput): { rows: Row[]; searchable: SearchScope[]; projectHits: Row[] } {
  const { builds, needle, show, manyHosts, chatsFolded, doneOpen, snoozedOpen, subchatFolds } = ctx;
  const chatRow = chatRowFor(manyHosts);
  const result: Row[] = [];
  const found: SearchScope[] = [];
  const offlineIds = builds.filter((build) => build.reach === "offline").map((build) => build.hostId);
  const offlineLine: Row[] = offlineIds.length ? [{ key: "offline", path: "", kind: "offline", hostIds: offlineIds }] : [];
  const homeRows = chatsGroupChats(
    builds.flatMap((build) => {
      const home = build.home;
      return home
        ? [
            {
              hostId: build.hostId,
              chats: home.chats.map((entry): ChatRow => Object.assign(chatRow(build, home, entry), { home: true })),
            },
          ]
        : [];
    }),
  ).map(({ entry }) => entry);
  const chatsList = chatsGroupList({
    computers: builds.length,
    rows: homeRows,
    folded: chatsFolded,
    homes: builds.flatMap((build) => (build.home ? [{ hostId: build.hostId, path: build.home.path }] : [])),
  });
  const chatsGroup: Row[] = chatsList ? [{ key: "chats-group", path: "", ...chatsList.header }, ...chatsList.rows] : [];
  if (needle || ctx.chatList === "list") flatRows(ctx, result, found, offlineLine);
  else groupedRows(ctx, result, chatsGroup, offlineLine);
  const hits: Row[] = needle
    ? builds.flatMap((build) =>
        build.projects
          .filter((project) => project.name.toLowerCase().includes(needle))
          .map((project) => ({
            key: `${build.hostId}|${project.path}:hit`,
            path: project.path,
            kind: "projectHit" as const,
            hostId: build.hostId,
            hostName: build.hostName,
            reach: build.reach,
            name: project.name,
            members: project.members,
            many: manyHosts,
          })),
      )
    : [];
  if (!needle && show === "all") {
    const snoozed = builds
      .flatMap((build) =>
        build.projects.concat(build.home ? [build.home] : []).flatMap((project) =>
          project.snoozed.map((entry): Extract<Row, { kind: "snoozed" }> => ({
            key: `snoozed:${build.hostId}|${project.path}#${entry.chat.id}`,
            path: project.path,
            kind: "snoozed",
            hostId: build.hostId,
            hostName: build.hostName,
            reach: build.reach,
            chat: entry.chat,
            title: entry.title,
            many: manyHosts,
            ...(project === build.home ? { home: true } : {}),
          })),
        ),
      )
      .sort((a, b) => bySnoozedUntil(a.chat, b.chat));
    if (snoozed.length) {
      result.push({
        key: "snoozed-header",
        path: "",
        kind: "snoozedHeader",
        count: snoozed.length,
        expanded: snoozedOpen,
      });
      if (snoozedOpen) result.push(...snoozed);
    }
  }
  if (!needle && show === "all") {
    const done = builds
      .flatMap((build) =>
        build.projects.concat(build.home ? [build.home] : []).flatMap((project) =>
          project.done.map((entry): Row => ({
            key: `done:${build.hostId}|${project.path}#${entry.chat.id}`,
            path: project.path,
            kind: "done",
            hostId: build.hostId,
            hostName: build.hostName,
            reach: build.reach,
            chat: entry.chat,
            title: entry.title,
            many: manyHosts,
            ...(project === build.home ? { home: true } : {}),
          })),
        ),
      )
      .sort((a, b) => ((b as { chat: AgentSession }).chat.done_at ?? 0) - ((a as { chat: AgentSession }).chat.done_at ?? 0));
    if (done.length) {
      result.push({
        key: "done-header",
        path: "",
        kind: "doneHeader",
        count: done.length,
        expanded: doneOpen,
      });
      if (doneOpen) result.push(...done);
    }
  }
  if (!needle && show !== "all" && !result.some((row) => row.kind === "chat"))
    result.unshift({
      key: "filter-empty",
      path: "",
      kind: "section",
      name: "No Chats match this filter.",
    });
  return {
    rows: nestChatRows(result, subchatFolds),
    searchable: found,
    projectHits: hits,
  };
}

export type SearchInput = {
  rows: Row[];
  needle: string;
  query: string;
  searchable: SearchScope[];
  hostMatches: { query: string; matches: Record<string, ChatSearchMatch[]> };
  /** chats:search per computer: hits from every Project on it, archived Chats when `archived`. */
  hostHits?: HostHits;
  hosts?: HostTag[];
  archived?: boolean;
  now?: number;
  projectHits: Row[];
  manyHosts: boolean;
  connected: boolean;
  ipad: boolean;
};

function hostRows({ hostHits, hosts = [], needle, archived = false, manyHosts, now = Date.now() }: SearchInput, found: Row[], notices: Row[]) {
  const answered = new Set<string>();
  if (!hostHits || hostHits.query !== needle || hostHits.archived !== archived) return answered;
  for (const tag of hosts) {
    const reply = hostHits.byHost[tag.hostId];
    if (!reply || "legacy" in reply) continue;
    answered.add(tag.hostId);
    const lines = "error" in reply ? [`Couldn't search ${tag.hostName}: ${reply.error}`] : failedLines(reply.result, manyHosts ? tag.hostName : undefined);
    for (const line of lines) notices.push({ key: `search-failed:${tag.hostId}:${line}`, path: "", kind: "notice", message: line, ...tag });
    if ("error" in reply) continue;
    for (const hit of reply.result.matches)
      found.push({
        key: `${tag.hostId}|${hit.projectPath}#${hit.chat.id}:message:${hit.message.id}`,
        path: hit.projectPath,
        kind: "message",
        ...tag,
        chatId: hit.chat.id,
        title: hit.chat.title,
        project: hit.projectName,
        many: manyHosts,
        snippet: hit.snippet,
        highlight: hit.highlight,
        ...(hit.chat.archived ? { archived: true } : {}),
        ...(hit.chat.lastAt ? { ago: activityAgo(hit.chat.lastAt, now) } : {}),
      });
  }
  return answered;
}

/** Include archived shows while a computer may honour it: hidden once every computer answered as too old for it. */
function archivedFilterShown({ hostHits, hosts = [], needle }: SearchInput) {
  if (!hostHits || !hosts.length) return false;
  if (hostHits.query !== needle) return true;
  return hosts.some((host) => !("legacy" in (hostHits.byHost[host.hostId] ?? { legacy: true })));
}

export function searchRows(input: SearchInput): Row[] {
  const { rows, needle, query, searchable, hostMatches, projectHits, manyHosts, connected, ipad, archived = false } = input;
  if (!needle) return rows;
  const found: Row[] = [];
  const notices: Row[] = [];
  const answered = hostRows(input, found, notices);
  for (const { hostId, hostName, reach, path, project, messages, chats } of searchable) {
    if (answered.has(hostId)) continue;
    const perChat = new Map<number, number>();
    const matches = messages ? searchMessages(messages, needle, 200) : hostMatches.query === needle ? (hostMatches.matches[`${hostId}\t${path}`] ?? []) : [];
    for (const match of matches) {
      const entry = chats.get(match.message.session_id);
      const count = perChat.get(match.message.session_id) ?? 0;
      if (!entry || count >= 3) continue;
      const { chat, title } = entry;
      perChat.set(chat.id, count + 1);
      found.push({
        key: `${hostId}|${path}#${chat.id}:message:${match.message.id}`,
        path,
        kind: "message",
        hostId,
        hostName,
        reach,
        chatId: chat.id,
        title,
        project,
        many: manyHosts,
        snippet: match.snippet,
        highlight: match.highlight,
      });
    }
  }
  const next = [...rows];
  if (archivedFilterShown(input)) next.push({ key: "search-filters", path: "", kind: "searchFilters", archived });
  if (found.length || notices.length)
    next.push(
      {
        key: "section:Messages",
        path: "",
        kind: "section",
        name: "Messages",
      },
      ...found.slice(0, 30),
      ...notices,
    );
  if (projectHits.length)
    next.push(
      {
        key: "section:Projects",
        path: "",
        kind: "section",
        name: "Projects",
      },
      ...projectHits,
    );
  const settings: Row[] = searchPhoneSettings(query, { connected, ipad })
    .slice(0, SETTINGS_SHOWN)
    .map(({ entry }) => ({
      key: `setting:${entry.row ? "row" : "page"}:${entry.page}:${entry.group ?? ""}:${entry.title}`,
      path: "",
      kind: "settingHit" as const,
      title: entry.title,
      trail: entry.row ? searchTrail(entry, SETTINGS_PAGES[entry.page].title) : "Settings",
      page: entry.page,
      find: entry.row ? entry.title : undefined,
    }));
  const settingsSection: Row[] = settings.length ? [{ key: "section:Settings", path: "", kind: "section", name: "Settings" }, ...settings] : [];
  if (!next.some((row) => row.kind === "chat" || row.kind === "message" || row.kind === "projectHit"))
    return [
      ...next.filter((row) => row.kind === "searchFilters" || row.kind === "notice"),
      { key: "start", path: "", kind: "start" as const, query },
      ...settingsSection,
    ];
  return [...next, ...settingsSection];
}
