// The Linear tools a Chat's agent gets, reading through the Mac's own Linear connections, so an agent never needs a
// Linear MCP or connector of its own. Read-only: nothing here writes to Linear.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { z } = require("zod");
const { isIssueKey } = require("./links.cjs");

const MAX_OUTPUT = 40_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ISSUE_URL = /^https:\/\/linear\.app\/([^/\s]+)\/issue\/([a-z][a-z0-9]{0,6}-\d+)(?:[/?#]|$)/i;
const UPLOAD_URL = /^https:\/\/uploads\.linear\.app\/[^\s]+$/;
const EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
};

const FULL = `query Full($id: String!) { issue(id: $id) {
  identifier title url description priorityLabel createdAt updatedAt
  state { name } assignee { name } creator { name }
  team { name } labels { nodes { name } } project { name } cycle { number name }
  parent { identifier title state { name } }
  children(first: 50) { nodes { identifier title state { name } } }
  relations(first: 50) { nodes { type relatedIssue { identifier title state { name } } } }
  inverseRelations(first: 50) { nodes { type issue { identifier title state { name } } } }
  attachments(first: 50) { nodes { title subtitle url } }
  comments(first: 100) { nodes { id body createdAt user { name } externalUser { name } botActor { name } parent { id } } }
} }`;

const cap = (text) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… truncated` : text);
const day = (iso) => String(iso ?? "").slice(0, 10);
const issueLine = (node) => `${node.identifier} ${node.title}${node.state?.name ? ` (${node.state.name})` : ""}`;
// Linear names a relation from the issue that holds it; the inverse side reads it the other way round.
const INVERSE = { blocks: "blocked by", duplicate: "duplicated by", related: "related", similar: "similar" };

function formatIssue(issue) {
  const facts = [
    `State: ${issue.state?.name ?? "unknown"}`,
    issue.priorityLabel && `Priority: ${issue.priorityLabel}`,
    `Assignee: ${issue.assignee?.name ?? "nobody"}`,
    issue.team?.name && `Team: ${issue.team.name}`,
    issue.project?.name && `Project: ${issue.project.name}`,
    issue.cycle && `Cycle: ${issue.cycle.name || issue.cycle.number}`,
    issue.labels?.nodes?.length && `Labels: ${issue.labels.nodes.map((label) => label.name).join(", ")}`,
  ].filter(Boolean);
  const parts = [
    `# ${issue.identifier}: ${issue.title}`,
    `${facts.join(" · ")}\nCreated ${day(issue.createdAt)} by ${issue.creator?.name ?? "unknown"}, updated ${day(issue.updatedAt)}\n${issue.url}`,
  ];
  if (issue.parent) parts.push(`Parent: ${issueLine(issue.parent)}`);
  parts.push(`## Description\n\n${issue.description?.trim() || "(none)"}`);
  const children = issue.children?.nodes ?? [];
  if (children.length) parts.push(`## Sub-issues\n\n${children.map((node) => `- ${issueLine(node)}`).join("\n")}`);
  const relations = [
    ...(issue.relations?.nodes ?? []).map((node) => `- ${node.type}: ${issueLine(node.relatedIssue)}`),
    ...(issue.inverseRelations?.nodes ?? []).map((node) => `- ${INVERSE[node.type] ?? node.type}: ${issueLine(node.issue)}`),
  ];
  if (relations.length) parts.push(`## Related issues\n\n${relations.join("\n")}`);
  const attachments = issue.attachments?.nodes ?? [];
  if (attachments.length)
    parts.push(`## Attachments\n\n${attachments.map((node) => `- ${node.title}${node.subtitle ? ` (${node.subtitle})` : ""}: ${node.url}`).join("\n")}`);
  const comments = [...(issue.comments?.nodes ?? [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (comments.length) {
    const author = (node) => node.user?.name ?? node.externalUser?.name ?? node.botActor?.name ?? "unknown";
    const lines = comments.map(
      (node) => `### ${author(node)}, ${day(node.createdAt)}${node.parent ? " (reply in a thread)" : ""}\n\n${node.body?.trim() ?? ""}`,
    );
    parts.push(`## Comments (${comments.length})\n\n${lines.join("\n\n")}`);
  }
  const text = parts.join("\n\n");
  if (/https:\/\/uploads\.linear\.app\//.test(text))
    parts.push("Files at uploads.linear.app need a Linear sign-in: download them with linear_file, then read the saved file.");
  return cap(parts.join("\n\n"));
}

/** `linear` holds the Mac's connections, `issues` reads issues through them (see linear/index.cjs and linear/issues.cjs). */
function createLinearTools({ linear, issues, dir = path.join(os.tmpdir(), "milagre-linear") }) {
  function connected() {
    if (!linear.enabled()) throw new Error("Linear is off in Milagre (Settings › Linear).");
    const ids = linear.workspaces().map((workspace) => workspace.id);
    if (!ids.length) throw new Error("Milagre isn't connected to Linear. The user can connect it in Settings › Linear.");
    return ids;
  }
  function checkWorkspace(workspace, ids) {
    if (workspace === undefined) return undefined;
    const id = workspace.toLowerCase();
    if (!ids.includes(id))
      throw new Error(
        `Milagre isn't connected to the "${workspace}" Linear workspace (connected: ${ids.join(", ")}). The user can add it in Settings › Linear › Add workspace.`,
      );
    return id;
  }

  // An issue key, or a Linear issue URL, whose workspace then is the URL's.
  async function find(ref, workspace) {
    const ids = connected();
    const text = String(ref ?? "").trim();
    const url = ISSUE_URL.exec(text);
    const key = (url ? url[2] : text).toUpperCase();
    if (!isIssueKey(key)) throw new Error("Give an issue key such as ENG-12, or a linear.app issue URL.");
    const named = checkWorkspace(workspace ?? url?.[1], ids);
    const found = await issues.readIssue(key, named);
    if (!found) throw new Error(`${key} isn't in ${named ? `the ${named} workspace` : `any connected Linear workspace (${ids.join(", ")})`}.`);
    return found;
  }

  async function issue(ref, workspace) {
    const found = await find(ref, workspace);
    const data = await linear.query(found.workspace, FULL, { id: found.key });
    if (!data?.issue) throw new Error(`${found.key} no longer exists in Linear.`);
    return formatIssue(data.issue);
  }

  async function search(query, workspace) {
    const ids = connected();
    if (typeof query !== "string" || !query.trim()) throw new Error("Give some text or an issue key to search for.");
    const named = checkWorkspace(workspace, ids) ?? ids[0];
    const result = await issues.list(query.trim(), { workspace: named, fresh: true });
    if (result.error) throw new Error(result.error);
    if (!result.issues.length)
      return `No issues match in ${named}.${ids.length > 1 ? ` Other connected workspaces: ${ids.filter((id) => id !== named).join(", ")}.` : ""}`;
    return cap(result.issues.map((item) => `- ${item.key} ${item.title} (${item.state.name}) ${item.url}`).join("\n"));
  }

  // Saved under the temp folder by the URL's hash, so asking again reuses the file.
  async function file(url, workspace) {
    const ids = connected();
    if (typeof url !== "string" || !UPLOAD_URL.test(url)) throw new Error("Give a file URL that starts with https://uploads.linear.app/.");
    const named = checkWorkspace(workspace, ids);
    let lastError = null;
    for (const id of named ? [named] : ids) {
      try {
        const { type, bytes } = await linear.download(id, url, { maxBytes: MAX_FILE_BYTES });
        const ext = EXTENSIONS[type.split(";")[0].trim()] ?? "";
        const target = path.join(dir, `${crypto.createHash("sha256").update(url).digest("hex").slice(0, 24)}${ext}`);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(target, bytes);
        return `Saved ${type || "the file"} (${bytes.length} bytes) to ${target}`;
      } catch (error) {
        lastError = error;
        if (error.code !== "not-found") throw error;
      }
    }
    throw new Error(named ? lastError.message : `None of the connected Linear workspaces (${ids.join(", ")}) has that file.`);
  }

  return { issue, search, file };
}

const workspace = z.string().optional().describe("A connected workspace's URL key (linear.app/<key>/…); by default, the one that has the issue.");

/** The Linear tools, as provider-neutral definitions (see linked-tools.cjs). Offered while Linear is on in Settings. */
function linearToolDefinitions(tools) {
  return [
    {
      name: "linear_issue",
      description:
        "Read a Linear issue through Milagre's own Linear sign-in: description, state, assignee, labels, parent, sub-issues, related issues, attachments and every comment. Use this instead of a Linear MCP or connector.",
      input: { issue: z.string().describe("An issue key such as ENG-12, or a linear.app issue URL."), workspace },
      readOnly: true,
      run: ({ issue, workspace }) => tools.issue(issue, workspace),
    },
    {
      name: "linear_search",
      description: "Search Linear issues by text or key through Milagre's own Linear sign-in. Lists key, title, state and URL.",
      input: { query: z.string(), workspace },
      readOnly: true,
      run: ({ query, workspace }) => tools.search(query, workspace),
    },
    {
      name: "linear_file",
      description:
        "Download a file uploaded to Linear (an https://uploads.linear.app/ URL from an issue or comment, such as a screenshot) through Milagre's Linear sign-in, and get the local path to read it from.",
      input: { url: z.string(), workspace },
      readOnly: true,
      run: ({ url, workspace }) => tools.file(url, workspace),
    },
  ];
}

module.exports = { createLinearTools, formatIssue, linearToolDefinitions };
