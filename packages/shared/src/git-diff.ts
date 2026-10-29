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

/** `base` is the branch name `committed` compares with, null for `uncommitted` or when there is none. `commit` confirms an immutable first-parent comparison. `message` explains an empty list (no shared history with the base). */
export type DiffFilesResult =
  | { isRepo: false; message: string }
  | { isRepo: true; commit?: string; commitParent?: string | null; truncated?: boolean; base: string | null; files: DiffFileEntry[]; message?: string };

/** `patch` is empty when the file is binary or `tooLarge` (over 1 MB). */
export type DiffFileResult = { patch: string; binary: boolean; tooLarge: boolean };

export type GitCommit = {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
} & (
  | { files: number; added: number; removed: number; statsUnavailable?: never }
  | { files: null; added: null; removed: null; statsUnavailable: "timeout" | "tooLarge" }
);

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
      /** Omitted when the caller already has branchesVersion. */
      branches?: GitBranch[];
      branchesVersion?: string;
      /** Checked live, independently of the cached catalogue. */
      baseMissing?: boolean;
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

export type GitBranch = { ref: string; name: string };
export type GitBranchCatalog = { version: string; branches: GitBranch[] };

/** Never reuse a catalogue from a different response version. Callers also scope it by host and folder. */
export function withHistoryBranches(data: GitHistory, catalog?: GitBranchCatalog): GitHistory {
  if (!data.isRepo || data.branches) return data;
  return { ...data, branches: catalog && data.branchesVersion === catalog.version ? catalog.branches : [] };
}

export function comparisonBaseMissing(data: Extract<GitHistory, { isRepo: true }>, selected: string): boolean {
  return !!selected && (data.baseMissing ?? data.branches?.every((branch) => branch.ref !== selected) ?? false);
}

export function commitStatsNotice(reason: NonNullable<GitCommit["statsUnavailable"]>): string {
  return reason === "timeout"
    ? "Totals unavailable: Git exceeded the read time limit. Retrying automatically."
    : "Totals unavailable: Git exceeded the output limit. Retrying automatically.";
}

/** Older hosts can omit the parent metadata; avoid asserting a parent until it is known. */
export function commitComparisonLabel(parent: string | null | undefined): string {
  return parent === null ? "First commit" : parent ? "Compared with first parent" : "Commit changes";
}

export function diffFileCountLabel(data: Extract<DiffFilesResult, { isRepo: true }>): string {
  return `${data.files.length}${data.truncated ? "+" : ""} ${data.files.length === 1 && !data.truncated ? "file" : "files"}`;
}
