import { useEffect, useMemo, useState } from "react";
import { chatPullRequests, ownsWorktree } from "@milagre/shared/chats";
import { pullRequestState, type OrchestratorTask } from "@milagre/shared/orchestrator";
import { allComputers, useComputerViews } from "./all-computers";
import { retentionOf, useDoneRetention } from "./done-retention";
import { taskHost } from "./orchestrator-actions";
import type { ProjectCopy } from "./all-computers-store";
import { boardItem, boardCounts, type BoardItem, type TaskChat } from "./orchestrator-board";
import { useListSnapshot, useSession } from "./session";
import { useComputerChatPullRequests, type ComputerPullRequestTargets } from "./use-chat-pull-requests";

type Joined = { task: OrchestratorTask; chat?: TaskChat; prPath?: string; prRefs: string[]; owned?: boolean };

function join(task: OrchestratorTask, copy: ProjectCopy | undefined): Joined {
  if (!copy || task.sessionId === null) return { task, prRefs: [] };
  const chat = copy.project.state.sessions[task.sessionId];
  if (!chat) return { task, prRefs: [] };
  const run = copy.runs.runs[`${copy.project.path}#${chat.id}`];
  const messages = copy.project.state.messages?.filter((message) => message.session_id === chat.id) ?? [];
  return {
    task,
    chat: { chat, run, messages },
    prPath: copy.project.state.worktrees[chat.worktree_id]?.path,
    prRefs: chat.summary?.pullRequests ?? copy.project.pullRequestRefs?.[chat.id] ?? [],
    owned: ownsWorktree(copy.project.state, chat.id, copy.project.path),
  };
}

function useNow(every: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/** The connected computer's tasks joined to their Chats, runs and PRs, as board cards. */
export function useOrchestratorBoard(tasks: readonly OrchestratorTask[]) {
  const session = useSession();
  const snapshot = useListSnapshot();
  const views = useComputerViews();
  const hostId = session.client?.url;
  const { cachedProject } = session;
  const now = useNow(30000);
  const joined = useMemo(
    () =>
      tasks.map((task) => {
        const path = task.projectPath;
        const at = taskHost(task, hostId, views);
        const view = views.find((entry) => entry.hostId === at);
        const here = at === hostId;
        const copy =
          !path || !at ? undefined : here && snapshot?.project.path === path ? snapshot : (view?.copies.get(path) ?? (here ? cachedProject(path) : undefined));
        return { ...join(task, copy), at };
      }),
    [tasks, snapshot, views, hostId, cachedProject],
  );
  const missing = joined
    .filter((entry) => entry.task.state === "started" && !entry.chat && entry.task.projectPath && entry.at)
    .map((entry) => `${entry.at}\t${entry.task.projectPath}`);
  const missingKey = [...new Set(missing)].sort().join("\n");
  useEffect(() => {
    if (!missingKey) return;
    for (const line of missingKey.split("\n")) {
      const [at = "", path = ""] = line.split("\t");
      void allComputers.refreshProject(at, path).catch(() => {});
    }
  }, [missingKey]);
  const targets = useMemo<ComputerPullRequestTargets[]>(() => {
    const byHost = new Map<string, Map<string, Set<string>>>();
    for (const entry of joined) {
      if (!entry.prPath || !entry.at) continue;
      const paths = byHost.get(entry.at) ?? new Map<string, Set<string>>();
      const refs = paths.get(entry.prPath) ?? new Set<string>();
      for (const ref of entry.prRefs) refs.add(ref);
      paths.set(entry.prPath, refs);
      byHost.set(entry.at, paths);
    }
    return [...byHost].map(([at, paths]) => ({
      hostId: at,
      client: at === hostId ? session.client : allComputers.clientFor(at),
      targets: [...paths].map(([path, refs]) => ({ path, refs: [...refs] })),
    }));
  }, [joined, hostId, session.client]);
  const status = useComputerChatPullRequests(targets);
  const hosts = [...new Set(joined.flatMap((entry) => (entry.chat?.chat.done_at && entry.at ? [entry.at] : [])))].sort();
  const doneHours = useDoneRetention(hosts, (at) => (at === hostId ? session.client : allComputers.clientFor(at)), hosts.length > 0);
  const items = useMemo<BoardItem[]>(
    () =>
      joined.map((entry) => {
        const found = entry.prPath && entry.at ? status[entry.at]?.[entry.prPath] : undefined;
        const prs = found ? chatPullRequests(entry.prRefs, found.found, entry.owned ? found.branch : undefined) : [];
        return boardItem(entry.task, entry.chat, pullRequestState(prs.map((pr) => pr.state)), now, entry.at ? retentionOf(doneHours, entry.at) : undefined);
      }),
    [joined, status, now, doneHours],
  );
  const counts = useMemo(() => boardCounts(items), [items]);
  return { items, counts };
}
