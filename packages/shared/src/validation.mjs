export const VALIDATION_LIMITS = Object.freeze({ commands: 12, name: 60, command: 2000, cwd: 300, tailLines: 40, tailChars: 6000 });

export const VALIDATION_COPY = Object.freeze({
  title: "Validation",
  commands: {
    label: "Commands",
    description:
      "Milagre runs these in the Chat's Worktree, one after another, and records each exit code and log. They are saved on this computer, outside the repository, so an agent can't change what checks its work.",
  },
  afterTask: {
    label: "Run after each task that changes files",
    description: "Follows the Chat's permission mode: Full and Auto run at once, Ask waits until you press Run.",
  },
  name: { label: "Name", placeholder: "Tests" },
  command: { label: "Command", placeholder: "npm test" },
  cwd: { label: "Folder", placeholder: "." },
  add: "Add command",
  empty: "No validation commands yet.",
});

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function normalizeFolder(value) {
  const folder = clip(value, VALIDATION_LIMITS.cwd)
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  if (!folder || folder === ".") return "";
  if (folder.startsWith("/") || /^[A-Za-z]:/.test(folder) || folder.split("/").some((part) => part === ".."))
    throw new Error("A folder must be inside the Worktree, like packages/core.");
  return folder;
}

/** Keeps commands with text, trimmed and capped; an unnamed command is named after its first word. */
export function normalizeValidationSettings(value) {
  const list = Array.isArray(value?.commands) ? value.commands : [];
  const commands = list
    .map((item) => ({
      name: clip(item?.name, VALIDATION_LIMITS.name),
      command: clip(item?.command, VALIDATION_LIMITS.command),
      cwd: normalizeFolder(item?.cwd),
    }))
    .filter((item) => item.command)
    .slice(0, VALIDATION_LIMITS.commands)
    .map((item) => ({ ...item, name: item.name || item.command.split(/\s+/)[0] }));
  return { commands, afterTask: value?.afterTask !== false };
}

const DONE = new Set(["passed", "failed", "not-run", "interrupted"]);
export const isValidationDone = (status) => DONE.has(status);

/** The run's status from its commands': interrupted wins, then a failure; a run with nothing run is not run. */
export function validationStatus(results, { running = false, interrupted = false } = {}) {
  if (running) return "running";
  if (interrupted || results.some((result) => result.status === "interrupted")) return "interrupted";
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.length && results.every((result) => result.status === "passed")) return "passed";
  return "not-run";
}

export function isValidation(message) {
  return message?.context?.kind === "validation";
}

export function formatValidationDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const TITLES = {
  running: "Running validation",
  passed: "Validation passed",
  failed: "Validation failed",
  "not-run": "Validation not run",
  interrupted: "Validation interrupted",
};
const TRIGGERS = { task: "after this task", user: "run by you", agent: "run by the agent" };

export function validationTitle(context) {
  return TITLES[context.status] ?? TITLES["not-run"];
}

/** The line beside the title: "1 of 3 failed · after this task · 1m 04s". */
export function validationMeta(context) {
  const results = context.results ?? [];
  const total = results.length;
  const count = (status) => results.filter((result) => result.status === status).length;
  const took = Number.isFinite(context.endedAt) && Number.isFinite(context.startedAt) ? formatValidationDuration(context.endedAt - context.startedAt) : "";
  if (context.status === "running") return `${count("passed") + count("failed") + 1} of ${total}`;
  if (context.status === "not-run") return context.reason ?? TRIGGERS[context.trigger] ?? "";
  const lead =
    context.status === "failed" ? `${count("failed")} of ${total} failed` : context.status === "passed" ? `${total} of ${total}` : (context.reason ?? "");
  return [lead, TRIGGERS[context.trigger], took].filter(Boolean).join(" · ");
}

export function validationText(context) {
  return `${validationTitle(context)}${context.status === "running" ? "" : `: ${validationMeta(context)}`}`;
}

export const VALIDATION_RESULT_WORDS = Object.freeze({
  passed: "Passed",
  failed: "Failed",
  "not-run": "Not run",
  interrupted: "Interrupted",
  running: "Running",
  queued: "Queued",
});

export function validationExit(result) {
  if (result.exitCode !== null && result.exitCode !== undefined) return `exit ${result.exitCode}`;
  return result.signal ?? "";
}

export function validationStaleText(stale) {
  const files = stale?.files ?? [];
  if (!files.length) return "Out of date: the code changed after this run";
  const shown = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? ` and ${files.length - 3} more` : "";
  return `Out of date: ${files.length === 1 ? "1 file" : `${files.length} files`} changed after this run (${shown}${more})`;
}

function resultLine(result) {
  const exit = validationExit(result);
  return `- ${result.name} (\`${result.command}\`${result.cwd ? ` in ${result.cwd}` : ""}): ${VALIDATION_RESULT_WORDS[result.status] ?? result.status}${exit ? `, ${exit}` : ""}${result.reason ? `, ${result.reason}` : ""}`;
}

/** What the agent is told at its next turn. Only Milagre writes it; the agent can't report its own result. */
export function validationAgentNote(context) {
  const failed = (context.results ?? []).filter((result) => result.status === "failed" && result.tail);
  const tails = failed.map((result) => `Last output of ${result.name}:\n${result.tail}`).join("\n\n");
  return `<milagre_note>Milagre ran the Project's validation commands (${TRIGGERS[context.trigger] ?? "requested"}): ${validationText(context)}.\n${(context.results ?? []).map(resultLine).join("\n")}${tails ? `\n\n${tails}` : ""}</milagre_note>`;
}

/** The message Ask to fix sends as the user's own. */
export function validationFixPrompt(context) {
  const failed = (context.results ?? []).filter((result) => result.status === "failed");
  const parts = failed.map(
    (result) =>
      `\`${result.command}\`${result.cwd ? ` in ${result.cwd}` : ""} ${validationExit(result) || "failed"}.${result.tail ? `\n\n\`\`\`\n${result.tail}\n\`\`\`` : ""}`,
  );
  return `Validation failed. Fix it:\n\n${parts.join("\n\n")}`;
}
