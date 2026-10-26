import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback } from "react";
import { useSession } from "./session";

/** What every PR page needs in its address: the Chat's Worktree, the PR number and the Chat to send to. */
export type PrRoute = { worktreeId: string; number: string; chat?: string };

export type PrPage = "checks" | "threads" | "files" | "review" | "guide" | "diff";

const PATHS = {
  checks: "/pr-checks",
  threads: "/pr-threads",
  files: "/pr-files",
  review: "/pr-review",
  guide: "/pr-guide",
  diff: "/pr-diff",
} as const;

/** Opens the PR sheet over the Chat. */
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

/** The PR page's address, with the Worktree's folder looked up in the open Project. */
export function usePrRoute() {
  const params = useLocalSearchParams<PrRoute & Record<string, string>>();
  const session = useSession();
  const worktree = session.snapshot?.project.state.worktrees[Number(params.worktreeId)];
  const number = Number(params.number);
  // The Chat's own agent writes the review guide first, as it writes commit messages.
  const chatId = params.chat ? Number(params.chat.slice(params.chat.lastIndexOf("#") + 1)) : NaN;
  const provider = Number.isSafeInteger(chatId) ? session.snapshot?.project.state.sessions[chatId]?.provider : undefined;
  const route: PrRoute = { worktreeId: String(params.worktreeId ?? ""), number: String(params.number ?? ""), ...(params.chat ? { chat: params.chat } : {}) };
  return { params, route, cwd: worktree?.path, number, client: session.client, provider, valid: !!worktree && Number.isSafeInteger(number) && number > 0 };
}

/** Closes the whole PR sheet from any page in it, back to the Chat. */
export function useCloseSheet() {
  const navigation = useNavigation();
  return useCallback(() => {
    const parent = navigation.getParent();
    if (parent?.canGoBack()) parent.goBack();
    else if (router.canGoBack()) router.back();
  }, [navigation]);
}
