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
const NONE = "none";

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const written = (issue) =>
  `${issue.identifier}: ${issue.title} (${issue.state?.name ?? "unknown"}${issue.assignee?.name ? `, assigned to ${issue.assignee.name}` : ""})\n${issue.url}`;

function changed(data, mutation, field) {
  const result = data?.[mutation];
  if (!result?.success || !result[field]) throw new Error("Linear didn't make the change.");
  return result[field];
}

function clearable(value, lookUp) {
  if (value === undefined) return undefined;
  return same(value, NONE) ? null : lookUp(value);
}

function createLinearEdits({ linear, issues, refs }) {
  function writable(workspace) {
    if (!linear.canWrite(workspace))
      throw new Error(
        `Milagre's sign-in to the ${workspace} Linear workspace can only read issues. The user can sign in to it again with Settings › Connections › Linear › Add workspace to allow changes.`,
      );
    return workspace;
  }

  async function locate(ref, workspace) {
    const found = await refs.find(ref, workspace);
    const data = await linear.query(found.workspace, ISSUE_IDS, { id: found.key });
    if (!data?.issue) throw new Error(`${found.key} no longer exists in Linear.`);
    return { workspace: found.workspace, key: found.key, id: data.issue.id, teamId: data.issue.team.id };
  }

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
