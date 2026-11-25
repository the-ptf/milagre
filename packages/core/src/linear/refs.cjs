const { isIssueKey } = require("./links.cjs");

const ISSUE_URL = /^https:\/\/linear\.app\/([^/\s]+)\/issue\/([a-z][a-z0-9]{0,6}-\d+)(?:[/?#]|$)/i;

function checkWorkspace(workspace, ids) {
  if (workspace === undefined) return undefined;
  const id = workspace.toLowerCase();
  if (!ids.includes(id))
    throw new Error(
      `Milagre isn't connected to the "${workspace}" Linear workspace (connected: ${ids.join(", ")}). The user can add it in Settings › Connections › Linear › Add workspace.`,
    );
  return id;
}

function createLinearRefs({ linear, issues, workspaceIds }) {
  const check = workspaceIds
    ? (workspace, ids) => {
        if (workspace === undefined) return undefined;
        const id = workspace.toLowerCase();
        if (!ids.includes(id)) throw new Error(`This account doesn't have access to the "${workspace}" Linear workspace.`);
        return id;
      }
    : checkWorkspace;
  function connected() {
    if (!linear.enabled()) throw new Error("Linear is off in Milagre (Settings › Connections › Linear).");
    const ids = workspaceIds ? workspaceIds() : linear.workspaces().map((workspace) => workspace.id);
    if (!ids.length && workspaceIds) throw new Error("This account doesn't have access to any connected Linear workspace.");
    if (!ids.length) throw new Error("Milagre isn't connected to Linear. The user can connect it in Settings › Connections › Linear.");
    return ids;
  }

  async function find(ref, workspace) {
    const ids = connected();
    const text = String(ref ?? "").trim();
    const url = ISSUE_URL.exec(text);
    const key = (url ? url[2] : text).toUpperCase();
    if (!isIssueKey(key)) throw new Error("Give an issue key such as ENG-12, or a linear.app issue URL.");
    if (workspaceIds && url) check(url[1], ids);
    const named = check(workspace ?? url?.[1], ids);
    const found = await issues.readIssue(key, named, workspaceIds ? ids : undefined);
    if (!found) throw new Error(`${key} isn't in ${named ? `the ${named} workspace` : `any connected Linear workspace (${ids.join(", ")})`}.`);
    return found;
  }

  return { connected, checkWorkspace: check, find };
}

module.exports = { createLinearRefs };
