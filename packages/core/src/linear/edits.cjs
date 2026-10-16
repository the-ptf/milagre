// The Linear writes a Chat's agent makes through the Mac's own connections (see tools.cjs): create an issue, change one,
// comment on one. The agent names teams, statuses, labels, users and projects; this turns them into Linear's ids.

const PRIORITIES = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };
const TEAMS = "query Teams { teams(first: 250) { nodes { id key name } } }";
const TEAM_STATES = "query States($id: String!) { team(id: $id) { states(first: 100) { nodes { id name } } } }";
const LABELS = "query Labels($filter: IssueLabelFilter) { issueLabels(first: 250, filter: $filter) { nodes { id name team { id } } } }";
const USERS = "query Users($filter: UserFilter) { users(first: 10, filter: $filter) { nodes { id name displayName email } } }";
const VIEWER_ID = "query Me { viewer { id } }";
const PROJECTS = "query Projects($filter: ProjectFilter) { projects(first: 10, filter: $filter) { nodes { id name } } }";
const ISSUE_IDS = "query Ids($id: String!) { issue(id: $id) { id team { id } } }";
const RESULT = "identifier title url state { name } assignee { name }";
const CREATE = `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${RESULT} } } }`;
const UPDATE = `mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${RESULT} } } }`;
const COMMENT = "mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }";
// What an agent passes to clear an assignee or a project.
const NONE = "none";

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const written = (issue) =>
  `${issue.identifier}: ${issue.title} (${issue.state?.name ?? "unknown"}${issue.assignee?.name ? `, assigned to ${issue.assignee.name}` : ""})\n${issue.url}`;

// What a mutation returned, or an error when Linear says it didn't happen.
function changed(data, mutation, field) {
  const result = data?.[mutation];
  if (!result?.success || !result[field]) throw new Error("Linear didn't make the change.");
  return result[field];
}

// Leaves a field alone when it isn't given and clears it with "none"; anything else is looked up.
function clearable(value, lookUp) {
  if (value === undefined) return undefined;
  return same(value, NONE) ? null : lookUp(value);
}

/** `refs` turns what the agent named into workspaces and issues (refs.cjs); `issues` keeps the chips' cache. */
function createLinearEdits({ linear, issues, refs }) {
  // Changing issues needs a sign-in that allowed it; one saved before Milagre asked for write access can only read.
  function writable(workspace) {
    if (!linear.canWrite(workspace))
      throw new Error(
        `Milagre's sign-in to the ${workspace} Linear workspace can only read issues. The user can sign in to it again with Settings › Connections › Linear › Add workspace to allow changes.`,
      );
    return workspace;
  }

  // An issue the agent named, with the ids a mutation takes.
  async function locate(ref, workspace) {
    const found = await refs.find(ref, workspace);
    const data = await linear.query(found.workspace, ISSUE_IDS, { id: found.key });
    if (!data?.issue) throw new Error(`${found.key} no longer exists in Linear.`);
    return { workspace: found.workspace, key: found.key, id: data.issue.id, teamId: data.issue.team.id };
  }

  // A team by key (ENG) or name; without a workspace, the one connected workspace that has it.
  async function findTeam(ref, workspace) {
    const ids = refs.connected();
    const named = refs.checkWorkspace(workspace, ids);
    const listed = await Promise.all((named ? [named] : ids).map(async (id) => ({ id, teams: (await linear.query(id, TEAMS))?.teams?.nodes ?? [] })));
    const found = listed.flatMap(({ id, teams }) =>
      teams.filter((team) => same(team.key, ref.trim()) || same(team.name, ref.trim())).map((team) => ({ workspace: id, teamId: team.id })),
    );
    if (found.length === 1) return found[0];
    if (found.length > 1)
      throw new Error(`Several connected workspaces have a team "${ref}" (${found.map((item) => item.workspace).join(", ")}). Name the workspace.`);
    const known = listed.map(({ id, teams }) => `${id}: ${teams.map((team) => `${team.key} (${team.name})`).join(", ") || "no teams"}`);
    throw new Error(`No team "${ref}" in ${named ? `the ${named} workspace` : "any connected Linear workspace"}. Teams: ${known.join("; ")}.`);
  }

  async function stateId(workspace, teamId, name) {
    const states = (await linear.query(workspace, TEAM_STATES, { id: teamId }))?.team?.states?.nodes ?? [];
    const state = states.find((item) => same(item.name, name));
    if (!state) throw new Error(`The team has no status "${name}". Its statuses: ${states.map((item) => item.name).join(", ")}.`);
    return state.id;
  }

  // A team's own label wins over a workspace label of the same name.
  async function labelIds(workspace, teamId, names) {
    const wanted = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    const filter = { or: wanted.map((name) => ({ name: { eqIgnoreCase: name } })) };
    const labels = ((await linear.query(workspace, LABELS, { filter }))?.issueLabels?.nodes ?? []).filter((label) => !label.team || label.team.id === teamId);
    const chosen = wanted.map((name) => {
      const matches = labels.filter((label) => same(label.name, name));
      return { name, label: matches.find((item) => item.team) ?? matches[0] };
    });
    const missing = chosen.filter((item) => !item.label).map((item) => `"${item.name}"`);
    if (missing.length) throw new Error(`No label named ${missing.join(", ")} for this team.`);
    return chosen.map((item) => item.label.id);
  }

  // "me" is the signed-in user; anyone else by email, name or display name.
  async function userId(workspace, ref) {
    if (same(ref, "me")) return (await linear.query(workspace, VIEWER_ID)).viewer.id;
    const value = ref.trim();
    const filter = { or: [{ email: { eqIgnoreCase: value } }, { name: { eqIgnoreCase: value } }, { displayName: { eqIgnoreCase: value } }] };
    const users = (await linear.query(workspace, USERS, { filter }))?.users?.nodes ?? [];
    if (users.length === 1) return users[0].id;
    if (!users.length) throw new Error(`No Linear user "${ref}" in ${workspace}. Use their email, name or display name, or "me".`);
    throw new Error(`Several Linear users match "${ref}": ${users.map((user) => user.email).join(", ")}. Use their email.`);
  }

  async function projectId(workspace, name) {
    const projects = (await linear.query(workspace, PROJECTS, { filter: { name: { eqIgnoreCase: name.trim() } } }))?.projects?.nodes ?? [];
    if (!projects.length) throw new Error(`No Linear project named "${name}" in ${workspace}.`);
    return projects[0].id;
  }

  // What the agent gave, as Linear's input for one team's issue. Every lookup runs at once; a field not given stays out.
  async function input(workspace, teamId, given) {
    const { title, description, priority, assignee, state, project, labels, addLabels, removeLabels, parent } = given;
    if (title !== undefined && !title.trim()) throw new Error("An issue needs a title.");
    const labelsOf = (names) => (names?.length ? labelIds(workspace, teamId, names) : undefined);
    const fields = {
      title: title?.trim(),
      description,
      priority: priority === undefined ? undefined : PRIORITIES[priority],
      assigneeId: clearable(assignee, (ref) => userId(workspace, ref)),
      stateId: state === undefined ? undefined : stateId(workspace, teamId, state),
      projectId: clearable(project, (name) => projectId(workspace, name)),
      labelIds: labelsOf(labels),
      addedLabelIds: labelsOf(addLabels),
      removedLabelIds: labelsOf(removeLabels),
      parentId: parent === undefined ? undefined : locate(parent, workspace).then((found) => found.id),
    };
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    return Object.fromEntries(await Promise.all(entries.map(async ([name, value]) => [name, await value])));
  }

  async function createIssue({ team, workspace, ...given }) {
    const target = await findTeam(team, workspace);
    writable(target.workspace);
    const fields = await input(target.workspace, target.teamId, given);
    const created = changed(await linear.query(target.workspace, CREATE, { input: { teamId: target.teamId, ...fields } }), "issueCreate", "issue");
    return `Created ${written(created)}`;
  }

  async function updateIssue({ issue, workspace, ...given }) {
    const found = await locate(issue, workspace);
    writable(found.workspace);
    const fields = await input(found.workspace, found.teamId, given);
    if (!Object.keys(fields).length) throw new Error("Name at least one thing to change.");
    const updated = changed(await linear.query(found.workspace, UPDATE, { id: found.id, input: fields }), "issueUpdate", "issue");
    // The Worktree chips read the new status on their next poll, not a minute later.
    issues.forget(found.key, found.workspace);
    return `Updated ${written(updated)}`;
  }

  async function comment({ issue, body, workspace }) {
    if (!body.trim()) throw new Error("A comment needs some text.");
    const found = await locate(issue, workspace);
    writable(found.workspace);
    const added = changed(await linear.query(found.workspace, COMMENT, { input: { issueId: found.id, body } }), "commentCreate", "comment");
    return `Commented on ${found.key}: ${added.url}`;
  }

  return { createIssue, updateIssue, comment };
}

module.exports = { createLinearEdits, PRIORITIES };
