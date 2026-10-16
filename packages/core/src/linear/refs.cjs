// What a Chat's agent names in a Linear tool call, turned into the Mac's connected workspaces and issues (see tools.cjs).
const { isIssueKey } = require("./links.cjs");

const ISSUE_URL = /^https:\/\/linear\.app\/([^/\s]+)\/issue\/([a-z][a-z0-9]{0,6}-\d+)(?:[/?#]|$)/i;

/** A workspace the agent named, in lower case, when it is connected; undefined when none was named. */
function checkWorkspace(workspace, ids) {
  if (workspace === undefined) return undefined;
  const id = workspace.toLowerCase();
  if (!ids.includes(id))
    throw new Error(
      `Milagre isn't connected to the "${workspace}" Linear workspace (connected: ${ids.join(", ")}). The user can add it in Settings › Connections › Linear › Add workspace.`,
    );
  return id;
}

/** `linear` holds the Mac's connections, `issues` reads issues through them (see linear/index.cjs and linear/issues.cjs). */
function createLinearRefs({ linear, issues }) {
  /** The connected workspace ids, or an error that says how to connect one. */
  function connected() {
    if (!linear.enabled()) throw new Error("Linear is off in Milagre (Settings › Connections › Linear).");
    const ids = linear.workspaces().map((workspace) => workspace.id);
    if (!ids.length) throw new Error("Milagre isn't connected to Linear. The user can connect it in Settings › Connections › Linear.");
    return ids;
  }

  /** An issue key, or a Linear issue URL, whose workspace then is the URL's: its key and the workspace that has it. */
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

  return { connected, checkWorkspace, find };
}

module.exports = { createLinearRefs };
