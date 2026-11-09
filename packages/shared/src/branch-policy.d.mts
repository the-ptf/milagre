export interface BranchPolicy {
  template: string;
  username: string;
  dashesOnly: boolean;
  baseBranch: string;
  trackBase: boolean;
  instructions: string;
}
export interface BranchPolicySettings {
  local: Partial<BranchPolicy>;
  effective: BranchPolicy;
  repository: Partial<BranchPolicy>;
}
export const BRANCH_POLICY_DEFAULTS: Readonly<BranchPolicy>;
type BranchCopyField = { label: string; description: string; placeholder?: string };
export const BRANCH_COPY: Readonly<{
  title: string;
  footer: string;
  template: BranchCopyField;
  username: BranchCopyField;
  dashesOnly: BranchCopyField;
  baseBranch: BranchCopyField;
  trackBase: BranchCopyField;
  instructions: BranchCopyField;
  example: string;
  repository: string;
  reset: string;
}>;
export function branchSlug(text: string): string;
export function branchTicket(text: string): string;
export function validBranchName(branch: unknown): boolean;
export function branchPolicyFields(value: unknown): Partial<BranchPolicy>;
export function validatePolicyBranch(branch: string, policy: BranchPolicy): string;
export function formatPolicyBranch(policy: BranchPolicy, input: { slug: string; ticket?: string; suffix?: string; preview?: boolean }): string;
export function validateBranchPolicy(policy: BranchPolicy): BranchPolicy;
export const BRANCH_TOKENS: readonly ("username" | "ticket" | "slug" | "suffix")[];
export function branchPolicyCheck(policy: BranchPolicy): { preview: string; template: string; baseBranch: string };
export function branchPolicyOverrides(settings: BranchPolicySettings, draft: BranchPolicy): Partial<BranchPolicy>;
