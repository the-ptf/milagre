const fs = require("node:fs/promises");
const path = require("node:path");
const { createGit } = require("./git/client.cjs");
const {
  BRANCH_POLICY_DEFAULTS,
  branchSlug,
  branchPolicyFields,
  validateBranchPolicy,
  formatPolicyBranch,
  validatePolicyBranch,
} = require("@milagre/shared/branch-policy");

const git = createGit().read;
const POLICY_FILE = ".milagre/worktree.json";

async function resolveBranchPolicy(projectPath, local = {}) {
  let repository = {};
  let text;
  try {
    text = await fs.readFile(path.join(projectPath, POLICY_FILE), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && Object.hasOwn(parsed, "git")) repository = branchPolicyFields(parsed.git);
    } catch (error) {
      throw new Error(`Fix ${POLICY_FILE} before creating a Worktree: ${error.message}`, { cause: error });
    }
  }
  const fields = branchPolicyFields(local);
  const effective = validateBranchPolicy({ ...BRANCH_POLICY_DEFAULTS, ...fields, ...repository });
  return { local: fields, repository, effective };
}

async function availablePolicyBranch(projectPath, policy, input, { issueBranch } = {}) {
  // Without an explicit template, retain Linear's suggested name if it meets this Project's rules.
  let branch;
  if (!policy.template && issueBranch !== undefined) {
    try {
      branch = validatePolicyBranch(issueBranch, policy);
    } catch {
      branch = validatePolicyBranch([input.ticket?.toLowerCase(), branchSlug(input.slug)].filter(Boolean).join("-"), policy);
    }
  }
  branch ??= formatPolicyBranch(policy, input);
  const taken = async (name) => (await git.refExists(projectPath, `refs/heads/${name}`)) || (await git.refExists(projectPath, `refs/remotes/origin/${name}`));
  if (await taken(branch)) branch = validatePolicyBranch(`${branch}-${input.suffix}`, policy);
  // Never borrow an existing local or remote branch, even if the collision suffix is already taken.
  if (await taken(branch)) throw new Error(`Branch ${branch} already exists. Try creating the Worktree again.`);
  return branch;
}

function branchPolicyNote(projectPath, policy) {
  if (!policy.template && !policy.dashesOnly && !policy.baseBranch && !policy.trackBase && !policy.instructions) return "";
  return [
    `Project Git branch rules for ${projectPath}:`,
    `Branch template: ${policy.template || (policy.dashesOnly ? "{slug}-{suffix}" : "milagre/{slug}-{suffix}")}.`,
    ...(policy.username ? [`Branch username: ${policy.username}.`] : []),
    ...(policy.dashesOnly
      ? ["New branch names must use lowercase letters, numbers and dashes only. This restriction does not apply to base branch names."]
      : []),
    ...(policy.baseBranch ? [`Default base for new branches: ${policy.baseBranch}.`] : []),
    policy.trackBase
      ? "New branches track their selected base."
      : "Create branches with --no-track. Set their own upstream on the first push; do not push changes to the base branch.",
    ...(policy.instructions ? [`Project branch instructions:\n${policy.instructions}`] : []),
  ].join("\n");
}

module.exports = { resolveBranchPolicy, availablePolicyBranch, branchPolicyNote };
