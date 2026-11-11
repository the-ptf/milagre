// Canvas Links (spec 003) as a chat list shows them: which Links reach a Chat's Worktree, whether two Chats are
// already linked, the endpoints a new Link between two Chats gets, and the message "Link and ask" sends. Shared by
// the desktop sidebar and the phone. Types: chat-links.d.mts.

export const CHAT_MODE_COPY = {
  shared: "Shared Chat",
  separate: "Separate Chats",
  shareDetail:
    "One agent will edit both existing Worktrees, with one permission setting starting in Ask. Their branches and files stay in place. Existing Chats become read-only. All Chats must be idle. End their Heartbeats, including Babysit PR, first.",
  separateDetail:
    "Keep the shared conversation read-only and start new separate Chats in the same Worktrees. Each Chat has its own permissions. Files and branches stay in place.",
};

/** Whether one end of a Link stands for this Worktree: the Worktree itself, or its whole Project. */
export function endpointCovers(endpoint, worktree) {
  if (!endpoint || !worktree || endpoint.project_id !== worktree.project_id) return false;
  return endpoint.worktree_path === undefined || endpoint.worktree_path === worktree.worktree_path;
}

/** The Link that already joins the two Worktrees, either way round, or undefined. */
export function linkBetween(links, a, b) {
  return links.find((link) => (endpointCovers(link.a, a) && endpointCovers(link.b, b)) || (endpointCovers(link.a, b) && endpointCovers(link.b, a)));
}

/**
 * Every Link that reaches the Worktree, each with its other end: a Worktree, or a whole Project (no `worktree_path`).
 * The order is the Links' own (the order they were made).
 */
export function linkedEnds(links, worktree) {
  const ends = [];
  for (const link of links) {
    if (endpointCovers(link.a, worktree)) ends.push({ link, other: link.b });
    else if (endpointCovers(link.b, worktree)) ends.push({ link, other: link.a });
  }
  return ends;
}

/** A Project↔Project Link only joins two different Projects; within one Project a Link joins two Worktrees. */
export function canLinkProjects(a, b) {
  return Boolean(a?.project_id && b?.project_id && a.project_id !== b.project_id);
}

/**
 * The two endpoints of a new Link between two Chats' Worktrees. `scope` "projects" links their whole Projects, and
 * falls back to the Worktrees when both are in the same Project.
 */
export function linkEndpoints(a, b, scope = "worktrees") {
  if (scope === "projects" && canLinkProjects(a, b)) return [{ project_id: a.project_id }, { project_id: b.project_id }];
  return [
    { project_id: a.project_id, worktree_path: a.worktree_path },
    { project_id: b.project_id, worktree_path: b.worktree_path },
  ];
}

const same = (x, y) => x.project_id === y.project_id && x.worktree_path === y.worktree_path;

/** The Link just made between two endpoints, found in the list the host answers with. */
export function findLink(links, a, b) {
  return links.find((link) => (same(link.a, a) && same(link.b, b)) || (same(link.a, b) && same(link.b, a)));
}

/** Why a Chat can't be linked to another: both in one Worktree, or a Link already joins their Worktrees. */
export function linkProblem(links, source, target) {
  if (source.project_id === target.project_id && source.worktree_path === target.worktree_path) return "same-worktree";
  return linkBetween(links, source, target) ? "linked" : null;
}

/** The short reason a list shows beside a Chat that can't be picked. */
export const LINK_PROBLEM_LABEL = { "same-worktree": "Same worktree", linked: "Already linked" };

/** How a list names the other end of a Link: "web / login-form", or "All of web" for a whole Project. */
export function linkedEndLabel(end, { project, branch } = {}) {
  const name = project || "Unavailable Project";
  if (end.worktree_path === undefined) return `All of ${name}`;
  return `${name} / ${
    branch ||
    end.worktree_path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ||
    end.worktree_path
  }`;
}

/**
 * "Link and ask A…": what goes to Chat A as a plain user message. The body is what the user typed plus the
 * destination, as the Chat shows it; the prompt adds the Chat ref and Worktree the agent's Link tools take. The agent
 * decides whether to make a Delegation; the user never sends one directly.
 */
export function linkAskMessage(text, target) {
  const where = [target.projectName, target.branch].filter(Boolean).join(" / ");
  const body = `${text.trim()}\n\nDestination: “${target.label}”${where ? ` (${where})` : ""}, in a linked Worktree.`;
  const prompt = `${body}\n\nThat Chat is ${target.chatRef} in the linked Worktree ${target.worktreePath}. If this needs changes there, make a Delegation to it with your Link tools (a Negotiation if the two sides must agree first); otherwise answer here.`;
  return { body, prompt };
}

/** Presentation and host validation share the same supported adoption boundary. */
export function sharedChatEligibility(link, projects) {
  if (!link?.a.worktree_path || !link.b.worktree_path) return "Choose a Link between two Worktrees.";
  if (link.a.project_id === link.b.project_id) return "Shared Chat needs Worktrees from different Projects.";
  for (const end of [link.a, link.b]) {
    const project = projects.find((item) => item.id === end.project_id);
    if (!project) return "A linked Project is unavailable.";
    if (project.path === end.worktree_path) return "Create isolated Worktrees first. Main checkouts keep separate Chats.";
  }
  return null;
}
export function chatModeLabel(link) {
  return link.chatModeTransition === "shared"
    ? "Switching to shared Chat"
    : link.chatModeTransition === "separate"
      ? "Switching to separate Chats"
      : link.sharedChat
        ? CHAT_MODE_COPY.shared
        : CHAT_MODE_COPY.separate;
}
export function chatModeActions(link, projects) {
  if (link.chatModeTransition)
    return [
      { mode: link.chatModeTransition, label: "Finish switching" },
      ...(link.chatModeTransition === "shared" ? [{ mode: "separate", label: "Return to separate Chats" }] : []),
    ];
  if (link.sharedChat) return [{ mode: "separate", label: "Use separate Chats" }];
  return sharedChatEligibility(link, projects) ? [] : [{ mode: "shared", label: "Use shared Chat" }];
}
export function chatModeEndLabel(end, projects, branch) {
  const project = projects.find((item) => item.id === end.project_id);
  return `${project?.name ?? "Unavailable Project"} / ${branch || end.worktree_path?.split(/[\\/]/).at(-1) || "Worktree"}`;
}
