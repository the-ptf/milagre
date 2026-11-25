import type { LinearIssue, LinearIssuesResult } from "@milagre/shared/linear";
import {
  GITHUB_ISSUE_PLACEHOLDER,
  GITHUB_ISSUE_TITLE,
  githubIssueKey,
  githubIssueState,
  githubIssuesFailure,
  type GithubIssue,
  type GithubIssuesResult,
} from "@milagre/shared/github-issue";
import { issueChoiceId } from "@milagre/shared/issue-start";
import { showChoiceSheet } from "./choice-store";
import type { Client } from "./client";
import { GithubLogo, LinearLogo } from "./icons";

let lastLinearWorkspace: string | undefined;

/** Opens the Linear issue sheet on the computer's assigned issues; rejects with what the computer said when it can't list them. */
export async function pickLinearIssue(client: Client, title: string, onPick: (issue: LinearIssue) => void) {
  const result = await client.call<LinearIssuesResult>("linear:issues", [lastLinearWorkspace ? { workspace: lastLinearWorkspace } : {}]);
  if ("error" in result) throw new Error(result.error);
  const seen = new Map<string, LinearIssue>();
  const keep = (list: LinearIssue[]) =>
    list.map((issue) => {
      seen.set(issueChoiceId(issue), issue);
      return { id: issueChoiceId(issue), title: `${issue.key} ${issue.title}`, subtitle: issue.state.name };
    });
  lastLinearWorkspace = result.workspace;
  showChoiceSheet({
    title,
    placeholder: "Search issues",
    emptyLabel: "No issues found.",
    leading: <LinearLogo size={18} tone="ink" />,
    items: keep(result.issues),
    tabs: result.workspaces?.map((workspace) => ({ id: workspace.id, label: workspace.name })),
    tab: result.workspace,
    load: async (workspace, fresh) => {
      const next = await client.call<LinearIssuesResult>("linear:issues", [{ fresh, ...(workspace ? { workspace } : {}) }]);
      if ("error" in next) throw new Error(next.error);
      if (next.workspace) lastLinearWorkspace = next.workspace;
      return keep(next.issues);
    },
    onSelect: (id) => {
      const issue = seen.get(id);
      if (issue) onPick(issue);
    },
  });
}

/** Opens the GitHub issue sheet on the Project's open issues, read with its computer's gh; typing searches, a pasted link finds that issue. */
export async function pickGithubIssue(client: Client, projectPath: string, onPick: (issue: GithubIssue) => void) {
  const list = async (query?: string, fresh = false) => {
    const result = await client
      .call<GithubIssuesResult>("github:issues", [{ projectPath, ...(query ? { query } : {}), fresh }])
      .catch((error: unknown) => Promise.reject(new Error(githubIssuesFailure(error instanceof Error ? error.message : error))));
    if (!result) throw new Error(githubIssuesFailure(""));
    if ("error" in result) throw new Error(result.error);
    return result;
  };
  const first = await list();
  const seen = new Map<string, GithubIssue>();
  const keep = ({ issues }: { issues: GithubIssue[] }) =>
    issues.map((issue) => {
      seen.set(issueChoiceId(issue), issue);
      return {
        id: issueChoiceId(issue),
        title: `${issue.repo === first.repo ? `#${issue.number}` : githubIssueKey(issue)} ${issue.title}`,
        subtitle: [githubIssueState(issue).name, ...(issue.labels ?? [])].join(" · "),
      };
    });
  showChoiceSheet({
    title: GITHUB_ISSUE_TITLE,
    placeholder: GITHUB_ISSUE_PLACEHOLDER,
    emptyLabel: "No open issues found.",
    leading: <GithubLogo size={18} tone="ink" />,
    items: keep(first),
    load: async (_tab, fresh) => keep(await list(undefined, fresh)),
    search: async (query) => keep(await list(query)),
    onSelect: (id) => {
      const issue = seen.get(id);
      if (issue) onPick(issue);
    },
  });
}
