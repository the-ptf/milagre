import type { OpenLink, PullRequestActionContext, WorktreeBinding } from "@milagre/shared/model";
import { BLOCKERS, pullRequestAction, rowPullRequests } from "@milagre/shared/pr-blockers";
import { pullRequestActionBody, pullRequestActionContext } from "@milagre/shared/pr-action";
import { openThreads } from "@milagre/shared/pull-request-review";
import type { MilagreBridge } from "../../electron";
import { chatPullRequestLink } from "../markdown/LinkMenu";
import { useBranchPullRequests, usePullRequest } from "./usePullRequest";

export function useLinkPullRequests({ members, projects, bridge }: { members: WorktreeBinding[]; projects: OpenLink["projects"]; bridge: MilagreBridge }) {
  const branchPrs = useBranchPullRequests({ paths: members.map((member) => member.worktreePath), active: members.length > 0, bridge });
  const entries = members.flatMap((member) => {
    const pr = branchPrs[member.worktreePath];
    return pr ? [{ member, pr, name: projects.find((project) => project.id === member.projectId)?.name ?? member.projectId }] : [];
  });
  const prs = rowPullRequests(entries.map(({ pr }) => pr));
  const placeOf = (pr: (typeof prs)[number]) => entries.find((entry) => entry.pr === pr);
  const memberPrs = prs.flatMap((pr) => placeOf(pr) ?? []);
  const first = memberPrs[0];
  const review = usePullRequest({ cwd: first?.member.worktreePath, number: first?.pr.number, active: first?.pr.state === "OPEN", bridge });
  const count = review.pr?.state === "OPEN" && review.pr.url === first?.pr.url ? openThreads(review.pr).length : 0;
  const blocker = pullRequestAction(prs);
  const context = blocker && pullRequestActionContext({ action: blocker.blocker, pr: blocker.pr.number, url: blocker.pr.url });
  const target = blocker && placeOf(blocker.pr);
  const action =
    blocker && context && target
      ? { body: pullRequestActionBody(context), request: { ...context, projectId: target.member.projectId }, look: BLOCKERS[blocker.blocker] }
      : null;
  function composerProps(
    open: (projectId: string) => void,
    send: (body: string, request: PullRequestActionContext & { projectId: string }) => void,
    prShown: boolean,
  ) {
    return {
      pullRequestLink: chatPullRequestLink(
        memberPrs.map((entry) => ({ ...entry, url: entry.pr.url })),
        (entry) => open(entry.member.projectId),
      ),
      pullRequestAction: action ? { label: action.look.action, tone: action.look.tone, onRun: () => send(action.body, action.request) } : undefined,
      pullRequestReview: first && count && !prShown ? { count, onOpen: () => open(first.member.projectId) } : undefined,
    };
  }
  return { memberPrs, composerProps };
}
