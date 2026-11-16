import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback } from "react";
import { projectOfKey } from "@milagre/shared/agent-runs";
import { useSession } from "./session";

export type PrRoute = { worktreeId: string; number: string; chat?: string; cwd?: string };

export type PrPage = "threads" | "review" | "diff" | "labels" | "reviewers";

const PATHS = {
  threads: "/pr-threads",
  review: "/pr-review",
  diff: "/pr-diff",
  labels: "/pr-labels",
  reviewers: "/pr-reviewers",
} as const;

export function openPullRequest(route: PrRoute) {
  router.push({ pathname: "/pull-request", params: route });
}

/** A page inside the PR sheet (or, from the iPad panel, the sheet opened at that page). */
export function openPrPage(page: PrPage, route: PrRoute, extra: Record<string, string> = {}) {
  router.push({ pathname: PATHS[page], params: { ...route, ...extra } });
}

/** A file's diff across the whole window, from the iPad panel: wide enough to show it side by side. */
export function openPrFile(route: PrRoute, path: string) {
  router.push({ pathname: "/pr-file", params: { ...route, path } });
}

export function usePrRoute() {
  const params = useLocalSearchParams<PrRoute & Record<string, string>>();
  const session = useSession();
  const link = session.snapshot?.project.link;
  const linkChat = link && params.chat ? link.state.sessions[params.chat.slice(params.chat.lastIndexOf("#") + 1)] : undefined;
  const member = linkChat?.worktrees.find((entry) => entry.worktreePath === params.cwd);
  const worktree = link ? (member ? { path: member.worktreePath } : undefined) : session.snapshot?.project.state.worktrees[Number(params.worktreeId)];
  const number = Number(params.number);
  const route: PrRoute = {
    worktreeId: String(params.worktreeId ?? ""),
    number: String(params.number ?? ""),
    ...(params.chat ? { chat: params.chat } : {}),
    ...(member ? { cwd: member.worktreePath } : {}),
  };
  const project = params.chat ? projectOfKey(params.chat) : undefined;
  const waiting = !session.client || !session.snapshot || (!!project && session.snapshot.project.path !== project);
  return {
    params,
    route,
    cwd: worktree?.path,
    number,
    client: session.client,
    valid: !!worktree && Number.isSafeInteger(number) && number > 0,
    waiting,
  };
}

export function useCloseSheet() {
  const navigation = useNavigation();
  return useCallback(() => {
    const parent = navigation.getParent();
    if (parent?.canGoBack()) parent.goBack();
    else if (router.canGoBack()) router.back();
  }, [navigation]);
}
