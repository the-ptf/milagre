export const BRANCH_POLICY_DEFAULTS = Object.freeze({
  template: "",
  username: "",
  dashesOnly: false,
  baseBranch: "",
  trackBase: false,
  instructions: "",
});

/** Settings copy, shared by desktop and phone. */
export const BRANCH_COPY = Object.freeze({
  title: "Branches",
  footer: "Applies to new Worktrees. Existing branches keep their names.",
  template: {
    label: "Branch name",
    description: "Built from the parts below. Add ? to skip a missing one, like {ticket?}. Empty uses Milagre's naming.",
    placeholder: "milagre/{slug}-{suffix}",
  },
  username: { label: "Username", description: "Fills {username}.", placeholder: "your-name" },
  dashesOnly: { label: "Dashes only", description: "Lowercase letters, numbers and dashes. No slashes." },
  baseBranch: {
    label: "Base branch",
    description: "New Chats start from it unless you pick another. Empty uses the current branch.",
    placeholder: "Current branch",
  },
  trackBase: { label: "Track the base branch", description: "Off leaves the upstream unset until the first push." },
  instructions: {
    label: "Agent instructions",
    description: "Conventions the agent follows when it names or renames a branch.",
    placeholder: "Use the Linear key when there is one",
  },
  example: "Example",
  repository: "Set in .milagre/worktree.json",
  reset: "Reset to defaults",
});

export function branchSlug(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** Only an unambiguous, explicit issue key in the prompt counts as a ticket. */
export function branchTicket(text) {
  const keys = [...new Set(String(text).match(/\b[A-Z][A-Z0-9]{1,15}-[0-9]+\b/g) ?? [])];
  return keys.length === 1 ? keys[0] : "";
}

export function validBranchName(branch) {
  if (typeof branch !== "string" || !branch || branch.startsWith("-") || branch === "@" || branch.includes("@{")) return false;
  if (branch === "HEAD" || branch.startsWith("refs/")) return false;
  if ([...branch].some((char) => char.charCodeAt(0) < 0x21 || char.charCodeAt(0) === 0x7f || " ~^:?*[\\".includes(char))) return false;
  if (branch.includes("..") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.includes("//")) return false;
  return branch.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** Validate only supplied fields, so repository defaults can be combined with a personal username. */
export function branchPolicyFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git branch settings must be an object.");
  const result = {};
  for (const [field, fallback] of Object.entries(BRANCH_POLICY_DEFAULTS)) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== typeof fallback)
      throw new Error(`Git branch setting ${field} must be ${typeof fallback === "boolean" ? "true or false" : "text"}.`);
    result[field] = typeof fallback === "string" ? value[field].trim() : value[field];
    if (typeof result[field] === "string" && result[field].length > (field === "instructions" ? 10000 : 1024))
      throw new Error(`Git branch setting ${field} is too long.`);
  }
  return result;
}

export function validatePolicyBranch(branch, policy) {
  if (!validBranchName(branch)) throw new Error(`${JSON.stringify(branch)} is not a valid branch name.`);
  if (policy.dashesOnly && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch))
    throw new Error("This Project requires lowercase branch names with letters, numbers and dashes only.");
  return branch;
}

/** Render in code: the model supplies a slug, never the template or Git arguments. */
export function formatPolicyBranch(policy, { slug, ticket = "", suffix = "", preview = false }) {
  const template = policy.template || (policy.dashesOnly ? "{slug}-{suffix}" : "milagre/{slug}-{suffix}");
  // A ticket already occupies its own slot; don't repeat it in the task's slug.
  const task =
    template.includes("{ticket") && ticket ? String(slug).replace(new RegExp(`\\b${ticket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ") : slug;
  const values = { slug: branchSlug(task) || "chat", username: policy.username, ticket: ticket.toLowerCase(), suffix };
  const rendered = template.replace(/[-/]?\{(username|ticket|slug|suffix)(\?)?\}/g, (match, field, optional) => {
    if (!values[field]) {
      if (optional) return "";
      if (preview && field === "username") return match.replace(/\{username\}/, "username");
      throw new Error(`The branch template needs a ${field}. Choose one before creating a Worktree, or use {${field}?}.`);
    }
    return match.replace(/\{[^}]+\}/, values[field]);
  });
  return validatePolicyBranch(rendered, policy);
}

export function validateBranchPolicy(policy) {
  if (policy.template && (!policy.template.includes("{slug}") || /[{}]/.test(policy.template.replace(/\{(?:username|ticket|slug|suffix)\??\}/g, ""))))
    throw new Error("A branch template must include {slug} and may only use {username}, {ticket}, {suffix} and their optional forms.");
  if (policy.baseBranch && !validBranchName(policy.baseBranch)) throw new Error("Choose a valid default base branch name.");
  formatPolicyBranch(policy, { slug: "fix-login", ticket: "ENG-123", suffix: "ab12", preview: true });
  return policy;
}

export const BRANCH_TOKENS = ["username", "ticket", "slug", "suffix"];

/** What Settings shows for a draft: the example name, or which field is wrong and why. */
export function branchPolicyCheck(policy) {
  const result = { preview: "", template: "", baseBranch: "" };
  if (policy.baseBranch && !validBranchName(policy.baseBranch)) result.baseBranch = "Not a valid branch name.";
  try {
    result.preview = formatPolicyBranch(validateBranchPolicy({ ...policy, baseBranch: "" }), {
      slug: "fix-login",
      ticket: "ENG-123",
      suffix: "ab12",
      preview: true,
    });
  } catch (failure) {
    result.template = failure instanceof Error ? failure.message : String(failure);
  }
  return result;
}

/** The personal overrides to save: every field the repository doesn't set, kept from the draft. */
export function branchPolicyOverrides(settings, draft) {
  const local = {};
  for (const field of Object.keys(BRANCH_POLICY_DEFAULTS)) {
    if (Object.hasOwn(settings.repository, field)) continue;
    if (draft[field] !== BRANCH_POLICY_DEFAULTS[field] || Object.hasOwn(settings.local, field)) local[field] = draft[field];
  }
  return local;
}
