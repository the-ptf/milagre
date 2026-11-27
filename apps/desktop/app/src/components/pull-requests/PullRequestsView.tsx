import { lazy, Suspense } from "react";
import type { AppView } from "../../lib/run-pane";
import { ChatIdentity } from "../agents/ChatIdentity";
import type { OpenPullRequestChat } from "./PullRequestsPage";

const PullRequestsPage = lazy(() => import("./PullRequestsPage").then((module) => ({ default: module.PullRequestsPage })));

/** The window's Pull requests view: its title in the top bar where a Chat's goes, and the page, while `view` is "pull-requests". */
export function PullRequestsView({ view, onOpenChat }: { view: AppView; onOpenChat: OpenPullRequestChat }) {
  if (view !== "pull-requests") return null;
  return (
    <>
      <ChatIdentity title="Pull requests" corner={0} />
      <Suspense fallback={null}>
        <PullRequestsPage onOpenChat={onOpenChat} />
      </Suspense>
    </>
  );
}
