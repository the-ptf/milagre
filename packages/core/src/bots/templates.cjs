const path = require("node:path");

// Starter bots. A template is a role, a mascot and a short setup card; the answers are written into the bot's
// BRIEF.md once, and the user edits the brief in the profile after that. Templates are generic: nothing in them names
// a repository, a release script or an account of anyone's.

const projectName = (projectPath) => path.basename(String(projectPath)) || String(projectPath);
const text = (value) => (typeof value === "string" ? value.trim() : "");

const OPS_TEMPLATE = Object.freeze({
  id: "ops",
  name: "Ops",
  role: "Keeps main green and PRs moving",
  color: "#3b82f6",
  body: "circle",
  fields: Object.freeze([
    Object.freeze({ id: "projects", label: "Projects to watch", kind: "projects", required: true }),
    Object.freeze({ id: "ci", label: "Checks that count as CI", kind: "text", required: false }),
    Object.freeze({ id: "linearTeam", label: "Linear team", kind: "text", required: false }),
  ]),
  brief(answers) {
    const projects = (answers.projects ?? []).map((projectPath) => `- ${projectName(projectPath)} (${projectPath})`);
    const ci = text(answers.ci);
    const team = text(answers.linearTeam);
    return [
      "Keep the main branch of these Projects green and their pull requests moving:",
      "",
      ...projects,
      "",
      ci ? `Checks that count as CI: ${ci}.` : "Every required check on the main branch counts as CI.",
      ...(team ? [`Linear team: ${team}. File what you find there, and read its issues for context.`] : []),
      "",
      "When main goes red:",
      "",
      "1. Find the failing check and the commit that broke it (`gh run list`, `gh run view --log-failed`).",
      "2. A test that fails now and then is flaky: note it in memory under Flaky tests and rerun the check once.",
      "3. A real failure: open a Milagre Chat with chat_open to fix it, and follow that Chat until its PR is green.",
      "",
      "For open pull requests: read their checks and reviews, say in this thread what blocks each one, and ask before merging.",
      "Run gated commands directly (`gh pr merge`, `git push`), never inside a script, so the sign-off card shows the exact command.",
      "",
    ].join("\n");
  },
});

const TEMPLATES = Object.freeze([OPS_TEMPLATE]);

/** The template's brief from the setup card's answers. */
function renderBrief(template, answers = {}) {
  return template.brief(answers ?? {});
}

/** The setup card's fields; a Projects field lists the Projects to pick from (the registry's). */
function setupFields(template, { projects = [] } = {}) {
  return template.fields.map((field) =>
    field.kind === "projects"
      ? { ...field, options: projects.map((project) => ({ value: project.path, label: project.name || projectName(project.path) })) }
      : { ...field },
  );
}

module.exports = { OPS_TEMPLATE, TEMPLATES, renderBrief, setupFields };
