export type DiffMode = "uncommitted" | "committed";

export type DiffFileEntry = {
  /** The new path, relative to the chat's folder. */
  path: string;
  /** Renames only. */
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  added: number;
  removed: number;
  binary: boolean;
  untracked?: boolean;
};

/** `base` is the branch name `committed` compares with, null for `uncommitted` or when there is none. `message` explains an empty list (no shared history with the base). */
export type DiffFilesResult = { isRepo: false; message: string } | { isRepo: true; base: string | null; files: DiffFileEntry[]; message?: string };

/** `patch` is empty when the file is binary or `tooLarge` (over 1 MB). */
export type DiffFileResult = { patch: string; binary: boolean; tooLarge: boolean };

export type GitCommit = {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
  files: number;
  added: number;
  removed: number;
};

export type GitHistory =
  | { isRepo: false; message: string }
  | {
      isRepo: true;
      branch: string | null;
      base: string | null;
      comparisonRef?: string | null;
      head?: string | null;
      total?: number;
      automatic?: { name: string; ref: string | null; reason: string };
      projectDefault?: { name: string; ref: string | null };
      suggested?: string | null;
      branches: { ref: string; name: string }[];
      commits: GitCommit[];
      hasMore: boolean;
      message?: string;
    };

/** Older desktop hosts can reject this optional read while still serving file diffs. */
export function isGitHistoryUnavailable(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error ?? "");
  return message === "Command is not available from mobile" || /Unknown command: git:history(?:[. ]|$)/.test(message);
}

/** Platform-neutral picker entries keep desktop and phone grouping and copy aligned. */
export function comparisonOptions(data: Extract<GitHistory, { isRepo: true }> | undefined) {
  const branchOptions = (data?.branches ?? []).map((branch) => {
    const remote = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(branch.ref);
    return {
      value: branch.ref,
      label: branch.name,
      description: branch.ref === `refs/heads/${data?.branch}` ? "current" : undefined,
      disabled: branch.ref === `refs/heads/${data?.branch}`,
      remote: !!remote,
      group: branch.ref === data?.suggested ? "Suggested" : remote ? `Remote · ${remote[1]}` : "Local",
    };
  });
  return [
    {
      value: "",
      label: "Automatic",
      description: data?.automatic
        ? `${data.automatic.name}, ${data.automatic.reason}`
        : data?.base
          ? `${data.base}, the automatic base`
          : "Recorded base or project default",
      disabled: false,
      remote: false,
      group: "",
    },
    ...branchOptions.filter((option) => option.group === "Suggested"),
    ...branchOptions.filter((option) => option.group === "Local"),
    ...branchOptions.filter((option) => option.remote && option.group !== "Suggested"),
  ];
}

export const branchName = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
export const commitInitials = (author: string) =>
  author
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word)[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";
