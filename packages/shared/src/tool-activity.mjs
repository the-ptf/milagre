// Shared presentation data for desktop and phone. Only summarize facts in retained tool output.
import { plainTaskOutput } from "./chat-activity.mjs";
import { providerName } from "./providers.mjs";

const INPUT_LIMIT = 4000;
const SECRET = /(?:password|secret|token|authorization|api[_-]?key|credential)/i;

/** Small, bounded tool identity and arguments; large design documents and file contents stay out of snapshots. */
export function toolMetadata(server, name, input) {
  const source = { name: String(name).slice(0, 160), ...(server ? { server: String(server).slice(0, 160) } : {}) };
  let args;
  if (input != null && !["design_show", "design_apply", "artifact_show", "html_render", "html_preview"].includes(name)) {
    try {
      args = JSON.stringify(input, (key, value) => (SECRET.test(key) ? "[redacted]" : value), 2);
      if (args?.length > INPUT_LIMIT) args = `${args.slice(0, INPUT_LIMIT)}\n… input truncated`;
    } catch {
      /* A non-serializable provider argument has no preview. */
    }
  }
  return { source, ...(args && args !== "{}" ? { input: args } : {}) };
}

/** Old messages can identify an MCP server from the existing canonical title, without rewriting it. */
export function stepSource(step) {
  const server = step.source?.server ?? /^Used `[^`]+` from ([\w .:-]+)$/.exec(step.title)?.[1];
  if (server) {
    const linear = /(?:^|[_\s-])linear(?:$|[_\s-])/i.test(server);
    return { id: `server:${server.toLowerCase()}`, label: linear ? "Linear" : server, kind: "other", linear };
  }
  return {
    id: step.kind,
    label:
      {
        shell: "Shell",
        setup: "Setup",
        read: "Read files",
        edit: "Edit files",
        search: "Search",
        thinking: "Thoughts",
        image: "Images",
        artifact: "Designs",
        other: "Tool",
      }[step.kind] ?? "Tool",
    kind: step.kind,
    linear: false,
  };
}

export function activitySources(steps, limit = 4) {
  const sources = new Map();
  for (const step of steps) {
    const source = stepSource(step);
    if (!sources.has(source.id)) sources.set(source.id, source);
  }
  return [...sources.values()].slice(0, limit);
}

export function formatStepDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function stepDuration(step, now) {
  return step.status === "running"
    ? step.startedAt == null
      ? ""
      : formatStepDuration(Math.max(0, now - step.startedAt))
    : formatStepDuration(step.durationMs);
}

/** Wall time spans the calls; parallel durations are never added together. */
export function activityDuration(steps, active, now) {
  const starts = steps.flatMap((step) => (Number.isFinite(step.startedAt) ? [step.startedAt] : []));
  if (!starts.length) return "";
  const ends = steps.flatMap((step) => (Number.isFinite(step.endedAt) ? [step.endedAt] : []));
  if (!active && !ends.length) return "";
  return formatStepDuration(Math.max(0, (active ? now : Math.max(...ends)) - Math.min(...starts)));
}

/** Keep the already bounded retained output distinct from the invocation. */
export function stepSections(step, detail = step.detail) {
  const text = detail ?? "";
  if ((step.kind === "shell" || step.kind === "setup") && text.startsWith("$ ")) {
    if (step.input && text.startsWith(`$ ${step.input}\n`))
      return { inputLabel: "Command", input: step.input, outputLabel: "Output", output: text.slice(step.input.length + 3) };
    const newline = text.indexOf("\n");
    return {
      inputLabel: "Command",
      input: text.slice(2, newline < 0 ? undefined : newline),
      outputLabel: "Output",
      output: newline < 0 ? "" : text.slice(newline + 1),
    };
  }
  return {
    inputLabel: step.kind === "shell" || step.kind === "setup" ? "Command" : "Input",
    input: step.input ?? step.file ?? "",
    outputLabel: step.kind === "edit" ? "Changes" : "Output",
    output: text,
  };
}

/** The Project a Link Chat's link_worktree_create step names, or null for another step or unreadable arguments. */
export function linkWorktreeProject(step) {
  if (step.source?.name !== "link_worktree_create") return null;
  try {
    const project = JSON.parse(step.input ?? "{}").project;
    return typeof project === "string" && project.trim() ? project.trim() : "";
  } catch {
    return "";
  }
}

/**
 * What a running turn is busy with when it isn't the agent's own work, for the label beside the running mark: a Link
 * Chat's Worktree being made, or a Worktree's setup. Null while the agent works, which the mark alone shows.
 */
export function runStatusLabel(steps = []) {
  const running = steps.filter((step) => step.status === "running");
  const creating = running.findLast((step) => linkWorktreeProject(step) !== null);
  const project = creating ? linkWorktreeProject(creating) : null;
  if (running.some((step) => step.kind === "setup")) return project ? `Running setup in ${project}` : "Running Worktree setup";
  if (creating) return project ? `Creating Worktree in ${project}` : "Creating Worktree";
  return null;
}

/** What a send waits on before its turn starts: its new Worktree, the host taking the message, then the agent starting. */
export function sendStatusLabel({ creatingWorktree = false, sent = false, provider }) {
  if (creatingWorktree) return "Creating Worktree";
  return sent ? `Starting ${providerName(provider)}` : "Sending";
}

export function stepDisplayTitle(step, running = false) {
  let title = step.kind === "thinking" && Number.isFinite(step.durationMs) && step.title.startsWith("Thought for ") ? "Thought" : step.title;
  const project = linkWorktreeProject(step);
  if (project !== null) title = project ? `Created Worktree in ${project}` : "Created Worktree";
  else if (step.source && /^Used (?:`|\w)/.test(title)) {
    const verbs = {
      get_issue: "Read issue",
      list_issues: "Listed issues",
      search_issues: "Searched issues",
      update_issue: "Updated issue",
      save_issue: "Saved issue",
      create_issue: "Created issue",
    };
    const name = step.source.name;
    const words = name.replace(/[_-]+/g, " ");
    let action = verbs[name] ?? words.charAt(0).toUpperCase() + words.slice(1);
    if (stepSource(step).linear && verbs[name] && step.input) {
      try {
        const args = JSON.parse(step.input);
        const key = args.identifier ?? args.id;
        if (typeof key === "string" && /^[A-Z][A-Z0-9]+-\d+$/i.test(key)) action = action.replace(/issue$/, `\`${key}\``);
      } catch {
        /* Truncated arguments keep the general action title. */
      }
    }
    title = `${action}${step.source.server ? ` from ${stepSource(step).label}` : ""}`;
  }
  if (running) {
    const verbs = {
      Ran: "Running",
      Read: "Reading",
      Edited: "Editing",
      Wrote: "Writing",
      Searched: "Searching",
      Used: "Using",
      Fetched: "Fetching",
      Listed: "Listing",
      Updated: "Updating",
      Saved: "Saving",
      Created: "Creating",
    };
    title = title.replace(/^(Ran|Read|Edited|Wrote|Searched|Used|Fetched|Listed|Updated|Saved|Created)\b/, (word) => verbs[word]);
  }
  return title;
}

/** Used at completion, before output moves to a sidecar or the phone drops it. */
export function summarizeStep(step) {
  if (step.kind === "thinking") return {};
  const output = plainTaskOutput(stepSections(step).output).trim();
  let tests;
  if (step.kind === "shell") {
    const pass = /^(?:#|ℹ)\s+pass (\d+)\s*$/m.exec(output),
      fail = /^(?:#|ℹ)\s+fail (\d+)\s*$/m.exec(output);
    if (pass && fail) tests = Number(fail[1]) ? `${fail[1]} failed · ${pass[1]} passed` : `${pass[1]} passed`;
    const totals = /^\s*Tests\s+([^\n]+)$/m.exec(output);
    if (!tests && totals && /\d+\s+(?:passed|failed|skipped)/.test(totals[1])) tests = totals[1].trim().slice(0, 80);
  }
  if (step.status === "failed") {
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const reason =
      lines.find((line) => /\b(?:\w*error|failed|failure|denied|not found|permission|exception)\b|^(?:not ok\b|[✖×]|FAIL(?::|\s+\D))/i.test(line)) ?? lines[0];
    return { summary: tests ?? "Failed", ...(reason ? { error: reason.slice(0, 200) } : {}) };
  }
  if (step.kind === "edit" && output) {
    const lines = output.split("\n");
    const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    if (added || removed) return { summary: `+${added} -${removed}` };
  }
  if (tests) return { summary: tests };
  if (step.source && (output.startsWith("[") || output.startsWith("{"))) {
    try {
      const items = JSON.parse(output);
      const rows = Array.isArray(items) ? items : (items?.issues ?? items?.results ?? items?.rows);
      if (Array.isArray(rows)) return { summary: `${rows.length} result${rows.length === 1 ? "" : "s"}` };
    } catch {
      /* Text output stays text. */
    }
  }
  return {};
}

export function waitingStepIds(approvals = []) {
  return approvals.flatMap((request) => (typeof request.stepId === "string" ? [request.stepId] : []));
}
