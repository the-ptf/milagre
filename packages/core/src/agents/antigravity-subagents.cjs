const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { acpStep, acpStepResult } = require("./acp-events.cjs");
const { code } = require("./steps.cjs");
const { active, update: setSubagent } = require("./subagents.cjs");

// Antigravity's subagents as Milagre subagents (docs/adr/0006-antigravity-over-acp.md). ACP says nothing about
// them: the parent's `start_subagent` call ends as soon as the children are launched, and the children's tool
// calls stream on the parent session with no parent field. What there is, verified against agy 1.3.0:
//   - a child's tool call id is "<child conversationId>:N", 32 hex digits before the colon; the parent's own are
//     "<session uuid>:N". view_file calls get ids like "call_474917" that name nobody.
//   - every conversation keeps a live transcript at <GEMINI_HOME>/antigravity-acp/brain/<id>/.system_generated/
//     logs/transcript.jsonl, one step per line ({ step_index, source, type, status, created_at, content,
//     tool_calls: [{ name, args }] }, args JSON-encoded), not always in step order.
//   - the parent's PLANNER_RESPONSE calls invoke_subagent with args.Subagents, a JSON list of { Role, Prompt };
//     the INVOKE_SUBAGENT step after it lists the children created, in the same order, as JSON objects with a
//     conversationId and logAbsoluteUri. A child's report arrives as a SYSTEM_MESSAGE step "sender=<child> ...
//     content=<report>"; the child's own transcript has the send_message call that sent it.
// All of this is undocumented, so every read is best effort: with no transcript, a launch stays the plain
// step it was before, and a call_* read the children may have made is shown again as the parent's.

const CHILD_ID = /^([0-9a-f]{32}):/;
const POLL_MS = 500;
// How long a launch may go without its children showing up in the parent's transcript.
const LAUNCH_TIMEOUT_MS = 10_000;
// A child still marked running this long after its turn ended, with no news, has stopped reporting.
const STALE_MS = 120_000;

const isUnattributed = (id) => id.startsWith("call_");
const toolName = (call) => /^(?:Running|Run)\s+([\w.:-]+)\??$/.exec(String(call?.title ?? "").trim())?.[1];
const isLaunch = (call) => toolName(call) === "start_subagent" && !call?.["_meta"]?.is_mcp_tool_call;

// Transcript args are JSON-encoded ('"sleep 6"'); Subagents is a JSON list inside that.
function decode(value) {
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

const str = (value) => (typeof value === "string" ? value : "");

// "[Message] timestamp=... sender=<id> priority=... content=<text>" inside a SYSTEM_MESSAGE step.
function systemMessage(step) {
  const match = /\[Message\][^\n]*?\bsender=(\S+)[^\n]*?\bcontent=([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/.exec(str(step.content));
  return match ? { sender: match[1], text: match[2].trim() } : null;
}

// The children an INVOKE_SUBAGENT step created, in order.
function createdChildren(step) {
  const content = str(step.content);
  if (!content.includes("Created the following subagents")) return [];
  const children = [];
  const pattern = /"conversationId"\s*:\s*"([0-9a-f]{32})"(?:\s*,\s*"logAbsoluteUri"\s*:\s*"([^"]+)")?/g;
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) children.push({ id: match[1], log: match[2] });
  return children;
}

function invokeSpecs(call) {
  const list = decode(call?.args?.Subagents);
  return Array.isArray(list) ? list.map((spec) => ({ title: str(spec?.Role).trim() || undefined, prompt: str(spec?.Prompt) || undefined })) : null;
}

function logPath(log) {
  if (!log?.startsWith("file://")) return null;
  try {
    return fileURLToPath(log);
  } catch {
    return null;
  }
}

/** One conversation's transcript, read as it grows. */
class Transcript {
  constructor(file, offset = 0) {
    Object.assign(this, { file, offset, rest: "", steps: new Map() });
  }

  /** New complete steps since the last read; [] when the file is missing or unchanged. */
  read() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    // A transcript that got shorter was rewritten: read it again; steps already seen are skipped by index.
    if (size < this.offset) Object.assign(this, { offset: 0, rest: "" });
    if (size === this.offset) return [];
    let chunk;
    try {
      const handle = fs.openSync(this.file, "r");
      try {
        const buffer = Buffer.alloc(size - this.offset);
        const length = fs.readSync(handle, buffer, 0, buffer.length, this.offset);
        chunk = buffer.subarray(0, length).toString("utf8");
        this.offset += length;
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      return [];
    }
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop();
    const steps = [];
    for (const line of lines) {
      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      if (!step || typeof step !== "object" || !Number.isInteger(step.step_index) || this.steps.has(step.step_index)) continue;
      this.steps.set(step.step_index, step);
      steps.push(step);
    }
    return steps;
  }

  /** Every step read so far, in step order. */
  ordered() {
    return [...this.steps.values()].toSorted((a, b) => a.step_index - b.step_index);
  }
}

const brainFile = (home, id) =>
  home && /^[\w-]+$/.test(String(id)) ? path.join(home, "antigravity-acp", "brain", String(id), ".system_generated", "logs", "transcript.jsonl") : null;

// Every step a transcript holds, a last line without its newline included (nothing is writing it any more).
function readTranscript(file) {
  if (!file) return [];
  const transcript = new Transcript(file);
  const steps = transcript.read();
  try {
    const step = JSON.parse(transcript.rest);
    if (step && Number.isInteger(step.step_index) && !transcript.steps.has(step.step_index)) steps.push(step);
  } catch {}
  return steps.toSorted((a, b) => a.step_index - b.step_index);
}

// What the child sent its parent with send_message, from the child's own transcript.
function sentReport(steps, recipients) {
  let report;
  for (const step of steps) {
    if (step.type !== "PLANNER_RESPONSE" || !Array.isArray(step.tool_calls)) continue;
    for (const call of step.tool_calls) {
      if (call?.name !== "send_message") continue;
      const args = Object.fromEntries(Object.entries(call.args ?? {}).map(([key, value]) => [key, decode(value)]));
      if (recipients.includes(str(args.Recipient)) && str(args.Message)) report = str(args.Message);
    }
  }
  return report;
}

/**
 * The saved children of an Antigravity chat that the transcripts prove finished, for a chat reopened after a restart.
 * Reads files only, starts nothing. A child is done when its parent's transcript holds a SYSTEM_MESSAGE from it (that
 * report is its result) or its own transcript ends in a send_message to the parent. Everything else stays unknown.
 * Never throws: missing or garbled files supply no evidence.
 * @returns {object[]} `subagent-update` events, with the same rows a live completion makes
 */
function recoverAntigravitySubagents({ home, parentId, agents }) {
  try {
    const unknown = (agents ?? []).filter((agent) => agent?.status === "unknown" && !agent.archived && agent.id !== parentId);
    if (!home || !parentId || !unknown.length) return [];
    const reports = new Map(); // parent id -> sender -> the report it got
    const reportsTo = (id) => {
      if (!reports.has(id)) {
        const senders = new Map();
        for (const step of readTranscript(brainFile(home, id))) {
          if (step.type !== "SYSTEM_MESSAGE") continue;
          const message = systemMessage(step);
          if (message) senders.set(message.sender, message.text);
        }
        reports.set(id, senders);
      }
      return reports.get(id);
    };
    const state = { subagents: new Map(unknown.map((agent) => [agent.id, agent])) };
    const events = [];
    for (const agent of unknown) {
      const owner = agent.parentId ?? parentId;
      let text = reportsTo(owner).get(agent.id);
      if (text === undefined) {
        text = sentReport(readTranscript(brainFile(home, agent.id)), [owner]);
        if (text === undefined) continue;
      }
      setSubagent(state, agent.id, { status: "completed", latestActivity: "Finished" }, text ? { id: "result", kind: "message", text } : undefined);
      const done = state.subagents.get(agent.id);
      events.push({ type: "subagent-update", agent: { ...done, updatedAt: Math.max(done.updatedAt, agent.updatedAt ?? 0) } });
    }
    return events;
  } catch {
    return [];
  }
}

class AntigravitySubagents {
  /**
   * @param {object} options
   * @param {object} options.state the session's mapper state: sessionId, and the subagents Map this adds to
   * @param {(event: object) => void} options.emit
   * @param {(update: object) => void} options.forward maps an update the usual way (a parent step)
   * @param {Record<string, string | undefined>} [options.env] the agent's environment: its GEMINI_HOME holds the transcripts; without one, launches stay plain steps
   * @param {() => boolean} [options.turnActive]
   */
  constructor({
    state,
    emit,
    forward,
    env,
    home = env?.GEMINI_HOME,
    turnActive = () => true,
    now = Date.now,
    pollMs = POLL_MS,
    launchTimeoutMs = LAUNCH_TIMEOUT_MS,
    staleMs = STALE_MS,
  }) {
    Object.assign(this, { state, emit, forward, home, now, pollMs, launchTimeoutMs, staleMs });
    this.turnActive = () => this.ending || turnActive();
    this.ending = false;
    this.children = new Map(); // id -> { parentId, transcript, done }
    this.calls = new Map(); // a child's tool calls, merged like the session's own
    this.launches = []; // this turn's start_subagent calls: { id, at, retitled }
    this.held = []; // call_* updates kept back while a launch waits for its children
    this.hidden = new Set(); // call_* ids the children made, as far as anyone can tell
    this.transcriptTools = new Set(["view_file"]);
    this.root = null;
    this.rootReads = 0;
    this.found = false; // a launch this turn was found in the transcript
    this.parentQuietSince = 0;
    this.waiting = false;
    this.turnEndedAt = null;
    this.timer = null;
    this.watchers = new Map();
    this.closed = false;
  }

  brain(id) {
    return brainFile(this.home, id);
  }

  /** Before a turn's prompt: what the parent's transcript holds already belongs to earlier turns. */
  beginTurn() {
    const file = this.state.sessionId ? this.brain(this.state.sessionId) : null;
    let offset = 0;
    try {
      if (file) offset = fs.statSync(file).size;
    } catch {}
    this.root = file ? new Transcript(file, offset) : null;
    Object.assign(this, { launches: [], held: [], found: false, turnEndedAt: null, waiting: false });
    this.hidden.clear();
  }

  /** Takes the session/update the subagents own. Returns true when the session must not map it itself. */
  route(update) {
    if (this.closed) return false;
    const kind = update?.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      // Reply text ends the waiting on its own (see agent-runs).
      this.parentActive(kind === "agent_thought_chunk");
      return false;
    }
    if (kind !== "tool_call" && kind !== "tool_call_update") return false;
    const id = String(update.toolCallId ?? "");
    const child = CHILD_ID.exec(id)?.[1];
    if (child && child !== this.state.sessionId && (this.children.has(child) || this.launches.length || this.anyActive())) {
      this.childCall(child, id, update);
      return true;
    }
    if (isUnattributed(id)) return this.unattributed(id, update);
    const previous = this.state.calls?.get(id) ?? {};
    const call = { ...previous, ...update };
    if (isLaunch(call) && !this.launches.some((launch) => launch.id === id) && ["in_progress", "completed"].includes(call.status ?? "in_progress")) {
      this.launches.push({ id, at: this.now() });
      this.schedule();
    }
    this.parentActive();
    return false;
  }

  // The parent itself is doing something, so it isn't just waiting on its children.
  parentActive(say = true) {
    this.parentQuietSince = this.now();
    if (!this.waiting) return;
    this.waiting = false;
    if (say) this.emit({ type: "subagents-waiting", waiting: false });
  }

  // A view_file call names nobody. While children run it is most likely theirs, and their transcripts show it.
  unattributed(id, update) {
    if (this.hidden.has(id)) return true;
    const name = toolName({ ...this.state.calls?.get(id), ...update });
    if (this.found && this.anyActive()) {
      this.hidden.add(id);
      if (name) this.transcriptTools.add(name);
      return true;
    }
    if (this.pendingLaunch()) {
      this.held.push(update);
      return true;
    }
    return false;
  }

  // A launch of this turn whose children the transcript hasn't shown yet.
  pendingLaunch() {
    return Boolean(this.root) && this.launches.some((launch) => !launch.matched && this.now() - launch.at < this.launchTimeoutMs);
  }

  anyActive() {
    for (const id of this.children.keys()) if (this.isActive(id)) return true;
    return false;
  }

  isActive(id) {
    const agent = this.state.subagents?.get(id);
    return Boolean(agent && active(agent));
  }

  push(events) {
    for (const event of events) this.emit(event);
  }

  // A child known from a tool call or a transcript. Its transcript is the one the parent's names, or the usual path.
  ensureChild(id, { parentId = null, log } = {}) {
    let child = this.children.get(id);
    if (!child) {
      const file = logPath(log) ?? this.brain(id);
      child = { parentId, transcript: file ? new Transcript(file) : null };
      this.children.set(id, child);
      this.push([setSubagent(this.state, id, { status: "running", latestActivity: "Starting", ...(parentId ? { parentId } : {}) })]);
      this.schedule();
    }
    return child;
  }

  childCall(childId, id, incoming) {
    this.ensureChild(childId);
    const call = { ...this.calls.get(id) };
    for (const [key, value] of Object.entries(incoming)) if (key !== "sessionUpdate" && value !== undefined) call[key] = value;
    if (incoming.rawInput && this.calls.get(id)?.rawInput) call.rawInput = { ...this.calls.get(id).rawInput, ...incoming.rawInput };
    this.calls.set(id, call);
    const status = call.status ?? "in_progress";
    const step = acpStep(call);
    const live = this.isActive(childId);
    if (status === "pending") {
      if (live) this.push([setSubagent(this.state, childId, { status: "waiting", latestActivity: `Waiting for approval: ${step.title}` })]);
      return;
    }
    if (status === "completed" || status === "failed") {
      this.calls.delete(id);
      const result = acpStepResult(call);
      const text = [step.title, result.status === "failed" && !result.detail ? "Failed" : result.detail].filter(Boolean).join("\n");
      this.push([setSubagent(this.state, childId, live ? { status: "running", latestActivity: step.title } : {}, { id, kind: "tool", text })]);
      return;
    }
    this.push([setSubagent(this.state, childId, live ? { status: "running", latestActivity: step.title } : {}, { id, kind: "tool", text: step.title })]);
  }

  schedule() {
    if (this.timer || this.closed || !this.pollMs) return;
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  // fs.watch makes a change show up at once; the timer is there for filesystems where it says nothing.
  watch(file) {
    const directory = path.dirname(file);
    if (this.watchers.has(directory) || !this.pollMs) return;
    try {
      const watcher = fs.watch(directory, { persistent: false }, () => {
        clearTimeout(this.soon);
        this.soon = setTimeout(() => this.poll(), 50);
        this.soon.unref?.();
      });
      watcher.on("error", () => {});
      this.watchers.set(directory, watcher);
    } catch {}
  }

  /** Reads what the transcripts added, then reports. Safe to call any time. */
  poll() {
    if (this.closed) return;
    try {
      this.readRoot();
      // A child may add children of its own while this runs; they are read on the next pass.
      for (const [id, child] of Array.from(this.children)) this.readChild(id, child);
      this.checkLaunches();
      this.checkWaiting();
      this.checkStale();
    } catch {}
    if (!this.pendingLaunch() && !this.anyActive()) this.stop();
  }

  readRoot() {
    if (!this.root) return;
    if (this.root.read().length) this.rootReads += 1;
    if (this.root.steps.size) this.watch(this.root.file);
    this.readInvocations(this.root, null);
    this.readMessages(this.root);
  }

  // invoke_subagent calls and the INVOKE_SUBAGENT steps that answer them, paired in step order.
  readInvocations(transcript, parentId) {
    const ordered = transcript.ordered();
    const specs = ordered.flatMap((step) =>
      step.type === "PLANNER_RESPONSE" && Array.isArray(step.tool_calls)
        ? step.tool_calls.filter((call) => call?.name === "invoke_subagent").map((call) => invokeSpecs(call) ?? [])
        : [],
    );
    const invoked = ordered.filter((step) => step.type === "INVOKE_SUBAGENT");
    invoked.forEach((step, index) => {
      const children = createdChildren(step);
      children.forEach((created, position) => {
        const spec = specs[index]?.[position] ?? {};
        const child = this.ensureChild(created.id, { parentId, log: created.log });
        if (parentId) child.parentId = parentId;
        const agent = this.state.subagents.get(created.id);
        const patch = {
          ...(spec.title && agent.title !== spec.title ? { title: spec.title } : {}),
          ...(spec.prompt && !agent.prompt ? { prompt: spec.prompt } : {}),
          ...(parentId && agent.parentId !== parentId ? { parentId } : {}),
        };
        if (Object.keys(patch).length) this.push([setSubagent(this.state, created.id, patch)]);
      });
      if (!parentId && children.length) {
        this.found = true;
        this.held = [];
        this.retitle(index, children);
      }
    });
  }

  // The launch step says who it started, once the transcript knows.
  retitle(index, children) {
    const launch = this.launches[index];
    if (!launch) return;
    launch.matched = true;
    if (!this.turnActive()) return;
    const names = children.map((child) => this.state.subagents.get(child.id)?.title).filter((title) => title && title !== "Subagent");
    const key = `${children.length}:${names.join("\n")}`;
    if (launch.retitled === key) return;
    launch.retitled = key;
    const list = names.length ? `: ${names.map((name) => code(name)).join(", ")}` : "";
    const title = children.length === 1 ? `Started a subagent${list}` : `Started ${children.length} subagents${list}`;
    this.emit({ type: "step-completed", id: launch.id, status: "done", title });
  }

  // A child's report to its parent ends it.
  readMessages(transcript) {
    for (const step of transcript.ordered()) {
      if (step.type !== "SYSTEM_MESSAGE") continue;
      const message = systemMessage(step);
      if (message && this.children.has(message.sender)) this.finish(message.sender, message.text);
    }
  }

  finish(id, text, status = "completed") {
    const child = this.children.get(id);
    if (!child || child.done) return;
    child.done = true;
    this.push([setSubagent(this.state, id, { status, latestActivity: "Finished" }, text ? { id: "result", kind: "message", text } : undefined)]);
  }

  readChild(id, child) {
    if (!child.transcript) return;
    const added = child.transcript.read();
    if (child.transcript.steps.size) this.watch(child.transcript.file);
    if (!added.length) return;
    child.changedAt = this.now();
    const live = () => this.isActive(id);
    for (const step of added.toSorted((a, b) => a.step_index - b.step_index)) {
      if (step.type === "SYSTEM_MESSAGE" && step.step_index === 0) {
        const message = systemMessage(step);
        const agent = this.state.subagents.get(id);
        if (message?.text && !agent.prompt) this.push([setSubagent(this.state, id, { prompt: message.text })]);
        continue;
      }
      if (step.type !== "PLANNER_RESPONSE") continue;
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      calls.forEach((call, index) => {
        const args = Object.fromEntries(Object.entries(call?.args ?? {}).map(([key, value]) => [key, decode(value)]));
        const parent = child.parentId ?? this.state.sessionId;
        if (call?.name === "send_message" && str(args.Recipient) === parent && str(args.Message)) {
          child.reportStep ??= step.step_index;
          this.finish(id, str(args.Message));
          return;
        }
        if (!this.transcriptTools.has(call?.name)) return;
        const file = str(args.AbsolutePath) || str(args.absolute_path) || str(args.TargetFile) || str(args.path);
        const title = call.name === "view_file" && file ? `Read ${code(path.basename(file))}` : str(args.toolSummary) || `Used ${code(String(call.name))}`;
        this.push([
          setSubagent(this.state, id, live() ? { latestActivity: title } : {}, { id: `step:${step.step_index}:${index}`, kind: "tool", text: title }),
        ]);
      });
      const text = str(step.content).trim();
      // What a child says after its report ("reported to the caller") repeats it.
      if (text && !(step.step_index > child.reportStep))
        this.push([setSubagent(this.state, id, live() ? { latestActivity: "Responding" } : {}, { id: `step:${step.step_index}`, kind: "message", text })]);
    }
    this.readInvocations(child.transcript, id);
    this.readMessages(child.transcript);
  }

  // A launch whose children never showed up: the reads held back for them are the parent's after all.
  checkLaunches() {
    if (!this.held.length || this.pendingLaunch()) return;
    const held = this.held;
    this.held = [];
    if (this.turnActive()) for (const update of held) this.forward(update);
  }

  // The parent waits on its children: say so when it has been quiet for a moment.
  checkWaiting() {
    if (!this.turnActive()) return;
    const waiting = this.found && this.anyActive() && this.now() - this.parentQuietSince >= this.pollMs;
    if (waiting === this.waiting) return;
    this.waiting = waiting;
    this.emit({ type: "subagents-waiting", waiting });
  }

  checkStale() {
    if (this.turnEndedAt === null) return;
    for (const [id, child] of this.children) {
      if (!this.isActive(id) || this.now() - Math.max(this.turnEndedAt, child.changedAt ?? 0) < this.staleMs) continue;
      child.done = true;
      this.push([setSubagent(this.state, id, { status: "unknown", latestActivity: "Stopped reporting." })]);
    }
  }

  /** At the end of a turn: the last word from the transcripts, then cancelled children are settled. */
  turnEnded({ cancelled = false } = {}) {
    // The turn's events are still being written: what this read finds belongs to it.
    this.ending = !cancelled;
    this.poll();
    this.ending = false;
    if (this.waiting) {
      this.waiting = false;
      this.emit({ type: "subagents-waiting", waiting: false });
    }
    // Reads still held back were never claimed by a child.
    if (this.held.length) {
      const held = this.held;
      this.held = [];
      for (const update of held) this.forward(update);
    }
    this.turnEndedAt = this.now();
    if (cancelled) this.settle("cancelled");
    else if (this.anyActive()) this.schedule();
  }

  /** Ends every child still running, as `status`. */
  settle(status) {
    for (const [id, child] of this.children) {
      if (!this.isActive(id)) continue;
      child.done = true;
      this.push([setSubagent(this.state, id, { status })]);
    }
  }

  close(status = "cancelled") {
    if (this.closed) return;
    this.settle(status);
    this.closed = true;
    this.stop();
    clearTimeout(this.soon);
  }
}

module.exports = { AntigravitySubagents, Transcript, createdChildren, decode, recoverAntigravitySubagents, systemMessage };
