/** What a flow Run keeps about an approval and the actions it took, split out of model.ts. */
export type FlowReceipt =
  | { kind: "pull-request"; url: string; number: number; branch: string; draft: boolean; matched: boolean; at: number }
  | { kind: "linear-comment"; issue: string; url?: string; at: number };

export interface FlowPullRequestPreview {
  repository?: string;
  /** Commit shown for approval, checked again before publishing the branch. */
  head?: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  changes?: string;
}

export interface FlowApproval {
  askedAt: number;
  expiresAt: number;
  message: string;
  preview?: FlowPullRequestPreview;
  decision?: "approved" | "rejected" | "expired";
  decidedAt?: number;
  reason?: string;
  by?: "autopilot";
  autopilot?: { at: number; summary: string };
}
