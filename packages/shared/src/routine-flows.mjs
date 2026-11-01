// Routine flows: the steps of a multi-step Routine, how they are checked and edited, what each step reads and gives, and
// how a Run's progress reads. Shared by the daemon (store.cjs, flow-runner.cjs), desktop and phone. Types:
// routine-flows.d.mts.

export const FLOW_LIMITS = Object.freeze({
  steps: 40,
  depth: 3,
  name: 60,
  prompt: 4000,
  text: 2000,
  fields: 12,
  choices: 12,
  askHours: 168,
  waitMinutes: 10080,
  timeoutHours: 168,
  retries: 5,
});

/** The step types, in the order the Add step menu lists them, with the words and Lucide icon both apps show. */
export const FLOW_STEP_TYPES = Object.freeze([
  { kind: "agent", name: "Ask an agent", short: "Ask an agent", description: "A turn in a Chat that returns fields you define", icon: "bot" },
  { kind: "if", name: "If", short: "If", description: "Pick a path from a field of an earlier step", icon: "split" },
  { kind: "ask", name: "Ask me", short: "Ask me", description: "Waits for your approval on any device", icon: "shield-check" },
  { kind: "wait", name: "Wait for", short: "Wait for", description: "A Linear state, a PR review or a time", icon: "hourglass" },
  {
    kind: "pull-request",
    name: "Open pull request",
    short: "Open PR",
    description: "Asks first, keeps a receipt, never opens twice",
    icon: "git-pull-request",
  },
  { kind: "linear-comment", name: "Comment on Linear", short: "Comment", description: "Posts to the issue once per Run", icon: "message-square" },
]);

const STEP_KINDS = new Set(FLOW_STEP_TYPES.map((type) => type.kind));
const FIELD_TYPES = new Set(["text", "choice", "yes-no", "number", "link"]);
const TESTS = new Set(["is", "is-not", "contains", "is-set"]);
const MODES = new Set(["ask", "auto", "full"]);
const STEP_ID = /^[a-z][a-z0-9-]{0,39}$/;
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/g;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" ? value : "");

/** What the trigger gives every step, by trigger kind, as `trigger.<path>` refs. */
const TRIGGER_FIELDS = {
  linear: [
    { path: "issue.key", type: "text", label: "issue.key" },
    { path: "issue.title", type: "text", label: "issue.title" },
    { path: "issue.description", type: "text", label: "issue.body" },
    { path: "issue.url", type: "link", label: "issue.url" },
    { path: "issue.labels", type: "text", label: "issue.labels" },
    { path: "issue.state", type: "text", label: "issue.state" },
    { path: "issue.team", type: "text", label: "issue.team" },
    { path: "comment.body", type: "text", label: "comment.body" },
    { path: "comment.author", type: "text", label: "comment.author" },
  ],
  webhook: [{ path: "delivery.id", type: "text", label: "delivery.id" }],
  schedule: [{ path: "time", type: "text", label: "time" }],
};

/** The trigger's fields as refs a step can read: `{ ref: "trigger.issue.title", label, type }`. */
export function triggerFields(triggerKind) {
  return (TRIGGER_FIELDS[triggerKind] ?? []).map((field) => ({ ref: `trigger.${field.path}`, label: field.label, type: field.type, stepName: "Trigger" }));
}

/** The words for a step type. */
export function stepType(kind) {
  return FLOW_STEP_TYPES.find((type) => type.kind === kind) ?? null;
}

/** A step id made from `name` that no step in `steps` has: "classify", then "classify-2"… */
export function newStepId(steps, name) {
  const taken = new Set(flattenSteps(steps).map((entry) => entry.step.id));
  const base =
    String(name ?? "step")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 32) || "step";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A new step of `kind` with the defaults the editor starts from. */
export function newStep(kind, steps = []) {
  const type = stepType(kind);
  if (!type) throw new Error(`Unknown step type: ${kind}`);
  const names = {
    agent: "Ask an agent",
    if: "If",
    ask: "Ask before going on",
    wait: "Wait",
    "pull-request": "Open pull request",
    "linear-comment": "Comment on Linear",
  };
  const name = names[kind];
  const id = newStepId(steps, kind === "agent" ? "agent" : kind === "if" ? "if" : name);
  if (kind === "agent") return { id, name, kind, prompt: "", chat: "run", output: [], retries: 1, onInvalid: "ask-once" };
  if (kind === "if") return { id, name, kind, field: "", test: "is", value: "", yes: [], otherwise: [] };
  if (kind === "ask") return { id, name, kind, message: "", expiresInHours: 24 };
  if (kind === "wait") return { id, name, kind, until: { kind: "time", minutes: 60 }, timeoutHours: 24 };
  if (kind === "pull-request") return { id, name, kind, title: "{{trigger.issue.key}} {{trigger.issue.title}}", body: "", draft: true, askFirst: true };
  return { id, name, kind, body: "" };
}

/**
 * Every step in run order, each with where it sits: `depth` (0 at the top), the If it is under (`parentId`) and which path
 * (`branch`), and its `index` in that list.
 */
export function flattenSteps(steps, depth = 0, parentId = null, branch = null, out = []) {
  for (const [index, step] of (Array.isArray(steps) ? steps : []).entries()) {
    out.push({ step, depth, parentId, branch, index });
    if (step?.kind === "if") {
      flattenSteps(step.yes, depth + 1, step.id, "yes", out);
      flattenSteps(step.otherwise, depth + 1, step.id, "otherwise", out);
    }
  }
  return out;
}

/** The step with `id`, or null. */
export function findStep(steps, id) {
  return flattenSteps(steps).find((entry) => entry.step.id === id)?.step ?? null;
}

// Rebuilds the tree with `edit(list, parentId, branch)` applied to every list (the top one too), deepest first.
function mapLists(steps, edit, parentId = null, branch = null) {
  const list = steps.map((step) =>
    step.kind === "if" ? { ...step, yes: mapLists(step.yes, edit, step.id, "yes"), otherwise: mapLists(step.otherwise, edit, step.id, "otherwise") } : step,
  );
  return edit(list, parentId, branch);
}

/** `steps` with `step` put at `index` of the list under If `parentId`'s `branch` (the top list when `parentId` is null). */
export function insertStep(steps, { parentId = null, branch = null, index }, step) {
  let placed = false;
  const next = mapLists(steps, (list, listParent, listBranch) => {
    if (listParent !== parentId || (parentId !== null && listBranch !== branch)) return list;
    placed = true;
    const at = Math.max(0, Math.min(index ?? list.length, list.length));
    return [...list.slice(0, at), step, ...list.slice(at)];
  });
  if (!placed) throw new Error("No such place in the flow");
  return next;
}

/** `steps` without the step `id` (and, for an If, the steps on its paths). */
export function removeStep(steps, id) {
  return mapLists(steps, (list) => list.filter((step) => step.id !== id));
}

/** `steps` with the step `id` replaced by `next` (its paths kept when `next` leaves them out). */
export function replaceStep(steps, id, next) {
  return mapLists(steps, (list) =>
    list.map((step) =>
      step.id === id
        ? step.kind === "if" && next.kind === "if"
          ? { ...next, yes: next.yes ?? step.yes, otherwise: next.otherwise ?? step.otherwise }
          : next
        : step,
    ),
  );
}

/** `steps` with step `id` moved one place up (-1) or down (+1) within its list; unchanged at an end. */
export function moveStep(steps, id, by) {
  return mapLists(steps, (list) => {
    const at = list.findIndex((step) => step.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= list.length) return list;
    const copy = [...list];
    [copy[at], copy[to]] = [copy[to], copy[at]];
    return copy;
  });
}

// The steps that have run by the time step `id` starts, on any path that reaches it: the earlier steps of its list, and of
// every list above it (an If's paths come after the If itself, so the If's own earlier steps count, its other path not).
function stepsBefore(steps, id) {
  const before = [];
  const search = (list) => {
    for (const step of list) {
      if (step.id === id) return true;
      if (step.kind === "if") {
        const mark = before.length;
        before.push(step);
        if (search(step.yes)) return true;
        before.length = mark + 1;
        if (search(step.otherwise)) return true;
        before.length = mark;
        // A path's steps may not have run, so only the If is known to have: a step after it can't read them.
      }
      before.push(step);
    }
    return false;
  };
  search(Array.isArray(steps) ? steps : []);
  return before;
}

/**
 * The fields step `id` can read: the trigger's, then each earlier agent step's outputs, as
 * `{ ref: "classify.complexity", label, type, choices, stepName }`. With no `id`, every agent step's fields.
 */
export function fieldsBefore(steps, id, triggerKind) {
  const earlier = id ? stepsBefore(steps, id) : flattenSteps(steps).map((entry) => entry.step);
  const fields = triggerFields(triggerKind);
  for (const step of earlier) {
    if (step.kind !== "agent") continue;
    for (const field of step.output ?? []) {
      fields.push({ ref: `${step.id}.${field.name}`, label: field.name, type: field.type, choices: field.choices, stepName: step.name });
    }
    // A pull-request step's link is read as `<id>.url`.
  }
  for (const step of earlier) if (step.kind === "pull-request") fields.push({ ref: `${step.id}.url`, label: "url", type: "link", stepName: step.name });
  return fields;
}

/** The refs a text reads as `{{ref}}`, each once, in order. */
export function placeholders(value) {
  const refs = [];
  for (const match of text(value).matchAll(PLACEHOLDER)) if (!refs.includes(match[1])) refs.push(match[1]);
  return refs;
}

/** What a step reads: the refs in its texts and, for an If, its field. */
export function stepReads(step) {
  if (!step) return [];
  if (step.kind === "agent") return placeholders(step.prompt);
  if (step.kind === "if") return step.field ? [step.field] : [];
  if (step.kind === "ask") return placeholders(step.message);
  if (step.kind === "pull-request") return [...new Set([...placeholders(step.title), ...placeholders(step.body)])];
  if (step.kind === "linear-comment") return placeholders(step.body);
  return [];
}

/** How many steps read `ref`. */
export function usedBy(steps, ref) {
  return flattenSteps(steps).filter((entry) => stepReads(entry.step).includes(ref)).length;
}

// ---- checking -------------------------------------------------------------------------------------------------------

function cleanField(value, where) {
  if (!isObject(value)) throw new Error(`${where}: a field must be an object`);
  const name = text(value.name).trim();
  if (!FIELD_NAME.test(name)) throw new Error(`${where}: "${name}" isn't a field name (letters, digits and _; a letter first)`);
  if (!FIELD_TYPES.has(value.type)) throw new Error(`${where}: field ${name} has an unknown type`);
  const field = { name, type: value.type };
  if (value.type === "choice") {
    const choices = (Array.isArray(value.choices) ? value.choices : []).map((choice) => text(choice).trim()).filter(Boolean);
    if (new Set(choices).size < 2) throw new Error(`${where}: field ${name} needs at least two choices`);
    if (choices.length > FLOW_LIMITS.choices) throw new Error(`${where}: field ${name} has too many choices`);
    field.choices = [...new Set(choices)];
  }
  const description = text(value.description).trim();
  if (description) field.description = description.slice(0, 200);
  return field;
}

function boundedNumber(value, min, max, where, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${where}: ${label} must be a whole number from ${min} to ${max}`);
  return number;
}

function cleanText(value, max, where, label, required = false) {
  const clean = text(value);
  if (required && !clean.trim()) throw new Error(`${where}: add ${label}`);
  if (clean.length > max) throw new Error(`${where}: ${label} is too long`);
  return clean;
}

function cleanStep(value, depth) {
  if (!isObject(value)) throw new Error("A step must be an object");
  const id = text(value.id);
  if (!STEP_ID.test(id)) throw new Error(`"${id}" isn't a step id (lowercase letters, digits and -)`);
  const name = text(value.name).trim();
  if (!name) throw new Error(`Step ${id}: add a name`);
  if (name.length > FLOW_LIMITS.name) throw new Error(`Step ${id}: the name is too long`);
  if (!STEP_KINDS.has(value.kind)) throw new Error(`Step ${id}: unknown step type ${JSON.stringify(value.kind)}`);
  const where = `Step "${name}"`;
  const base = { id, name, kind: value.kind };
  switch (value.kind) {
    case "agent": {
      const step = { ...base, prompt: cleanText(value.prompt, FLOW_LIMITS.prompt, where, "a prompt", true) };
      for (const key of ["provider", "model", "effort"]) if (typeof value[key] === "string" && value[key]) step[key] = value[key];
      if (value.permissionMode != null) {
        if (!MODES.has(value.permissionMode)) throw new Error(`${where}: unknown permission mode`);
        step.permissionMode = value.permissionMode;
      }
      step.chat = value.chat === "own" ? "own" : "run";
      const output = (Array.isArray(value.output) ? value.output : []).map((field) => cleanField(field, where));
      if (output.length > FLOW_LIMITS.fields) throw new Error(`${where}: too many output fields`);
      if (new Set(output.map((field) => field.name)).size !== output.length) throw new Error(`${where}: two output fields have the same name`);
      step.output = output;
      step.retries = value.retries == null ? 1 : boundedNumber(value.retries, 0, FLOW_LIMITS.retries, where, "retries");
      step.onInvalid = value.onInvalid === "stop" ? "stop" : "ask-once";
      return step;
    }
    case "if": {
      if (depth >= FLOW_LIMITS.depth) throw new Error(`${where}: Ifs nest ${FLOW_LIMITS.depth} deep at most`);
      if (!TESTS.has(value.test)) throw new Error(`${where}: unknown test`);
      const step = { ...base, field: text(value.field).trim(), test: value.test };
      if (!step.field) throw new Error(`${where}: choose a field to test`);
      if (value.test !== "is-set") step.value = cleanText(value.value, 200, where, "a value", true);
      step.yes = cleanSteps(value.yes ?? [], depth + 1);
      step.otherwise = cleanSteps(value.otherwise ?? [], depth + 1);
      return step;
    }
    case "ask":
      return {
        ...base,
        message: cleanText(value.message, FLOW_LIMITS.text, where, "a message"),
        expiresInHours: boundedNumber(value.expiresInHours ?? 24, 1, FLOW_LIMITS.askHours, where, "the time limit"),
      };
    case "wait": {
      const until = isObject(value.until) ? value.until : {};
      let clean;
      if (until.kind === "time") clean = { kind: "time", minutes: boundedNumber(until.minutes, 1, FLOW_LIMITS.waitMinutes, where, "minutes") };
      else if (until.kind === "linear-state") clean = { kind: "linear-state", state: cleanText(until.state, 80, where, "a state", true).trim() };
      else if (until.kind === "pr-review") clean = { kind: "pr-review" };
      else throw new Error(`${where}: choose what to wait for`);
      return { ...base, until: clean, timeoutHours: boundedNumber(value.timeoutHours ?? 24, 1, FLOW_LIMITS.timeoutHours, where, "the time limit") };
    }
    case "pull-request": {
      const step = {
        ...base,
        title: cleanText(value.title, 300, where, "a title", true),
        body: cleanText(value.body, FLOW_LIMITS.text, where, "a description"),
        draft: value.draft !== false,
        askFirst: value.askFirst !== false,
      };
      const baseBranch = text(value.base).trim();
      if (baseBranch) step.base = baseBranch;
      return step;
    }
    default:
      return { ...base, body: cleanText(value.body, FLOW_LIMITS.text, where, "the comment", true) };
  }
}

function cleanSteps(value, depth = 0) {
  if (!Array.isArray(value)) throw new Error("Steps must be a list");
  return value.map((step) => cleanStep(step, depth));
}

/**
 * The flow's steps checked and cleaned, or an Error naming the first problem: the shape of each step, then what the flow
 * as a whole needs (unique ids, at most 40 steps, every `{{ref}}` and If field readable where it is used, Linear steps only
 * under a Linear trigger, a review wait only after a pull request).
 */
export function checkFlowSteps(value, triggerKind) {
  const steps = cleanSteps(value);
  const problem = flowProblems(steps, triggerKind)[0];
  if (problem) throw new Error(problem.message);
  return steps;
}

/** Every problem with a flow, as `{ stepId, message }`; empty when it can run. */
export function flowProblems(steps, triggerKind) {
  const problems = [];
  const all = flattenSteps(steps);
  if (all.length === 0) problems.push({ stepId: null, message: "Add at least one step" });
  if (all.length > FLOW_LIMITS.steps) problems.push({ stepId: null, message: `A flow has ${FLOW_LIMITS.steps} steps at most` });
  const seen = new Set();
  for (const { step } of all) {
    if (seen.has(step.id)) problems.push({ stepId: step.id, message: `Two steps have the id ${step.id}` });
    seen.add(step.id);
  }
  for (const { step } of all) {
    const readable = new Set(fieldsBefore(steps, step.id, triggerKind).map((field) => field.ref));
    for (const ref of stepReads(step)) {
      if (!readable.has(ref)) problems.push({ stepId: step.id, message: `"${step.name}" reads ${ref}, which no earlier step gives` });
    }
    if (step.kind === "agent" && !text(step.prompt).trim()) problems.push({ stepId: step.id, message: `"${step.name}" needs a prompt` });
    if (step.kind === "if" && !step.field) problems.push({ stepId: step.id, message: `"${step.name}" needs a field to test` });
    const needsIssue = step.kind === "linear-comment" || (step.kind === "wait" && step.until?.kind === "linear-state");
    if (needsIssue && triggerKind !== "linear") problems.push({ stepId: step.id, message: `"${step.name}" needs a Linear trigger` });
    if (step.kind === "wait" && step.until?.kind === "pr-review") {
      const before = stepsBefore(steps, step.id);
      if (!before.some((earlier) => earlier.kind === "pull-request"))
        problems.push({ stepId: step.id, message: `"${step.name}" waits for a review, so a pull request must come first` });
    }
  }
  return problems;
}

// ---- running ----------------------------------------------------------------------------------------------------------

/** What a trigger's event gives the steps, as the object `trigger.<path>` refs read. */
export function triggerValues(event, at) {
  const values = {};
  if (event?.kind === "linear") {
    const issue = event.issue ?? {};
    values.issue = {
      key: issue.key,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      labels: Array.isArray(issue.labels) ? issue.labels.join(", ") : "",
      state: issue.state,
      team: issue.team,
    };
    if (event.comment) values.comment = { body: event.comment.body, author: event.comment.author };
  } else if (event?.kind === "webhook") values.delivery = { id: event.deliveryId };
  if (at !== undefined) values.time = new Date(at).toISOString();
  return values;
}

/** The value a ref reads from `values` ({ trigger, <stepId>: output }), or undefined. */
export function readRef(values, ref) {
  let current = values;
  for (const part of String(ref).split(".")) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** `value` with every `{{ref}}` replaced by what it reads; a ref with nothing to read becomes empty. */
export function fillTemplate(value, values) {
  return text(value).replace(PLACEHOLDER, (_, ref) => {
    const found = readRef(values, ref);
    if (found === undefined || found === null) return "";
    return typeof found === "object" ? JSON.stringify(found) : String(found);
  });
}

/** Whether an If's test holds for `values`. */
export function testCondition(step, values) {
  const found = readRef(values, step.field);
  if (step.test === "is-set") return found !== undefined && found !== null && found !== "" && found !== false;
  const actual = String(found ?? "")
    .trim()
    .toLowerCase();
  const expected = String(step.value ?? "")
    .trim()
    .toLowerCase();
  if (step.test === "contains") return actual.includes(expected);
  // A list of choices ("small, medium") in the value means any of them.
  const options = expected.split(/\s*(?:,|\bor\b)\s*/).filter(Boolean);
  const matches = options.length > 1 ? options.includes(actual) : actual === expected;
  return step.test === "is" ? matches : !matches;
}

/**
 * `value` checked against an agent step's fields: `{ ok: true, output }` with each field in its type, or
 * `{ ok: false, error }` saying what to fix, for the agent to read.
 */
export function checkOutput(fields, value) {
  if (!isObject(value)) return { ok: false, error: "Send the fields as an object" };
  const output = {};
  const errors = [];
  for (const field of fields) {
    const raw = value[field.name];
    if (raw === undefined || raw === null || raw === "") {
      errors.push(`${field.name} is missing`);
      continue;
    }
    if (field.type === "choice") {
      const match = field.choices.find((choice) => choice.toLowerCase() === String(raw).trim().toLowerCase());
      if (match) output[field.name] = match;
      else errors.push(`${field.name} must be one of ${field.choices.join(", ")}`);
    } else if (field.type === "yes-no") {
      if (typeof raw === "boolean") output[field.name] = raw;
      else if (/^(yes|true)$/i.test(String(raw).trim())) output[field.name] = true;
      else if (/^(no|false)$/i.test(String(raw).trim())) output[field.name] = false;
      else errors.push(`${field.name} must be yes or no`);
    } else if (field.type === "number") {
      const number = Number(raw);
      if (Number.isFinite(number)) output[field.name] = number;
      else errors.push(`${field.name} must be a number`);
    } else if (field.type === "link") {
      if (/^https?:\/\/\S+$/i.test(String(raw).trim())) output[field.name] = String(raw).trim();
      else errors.push(`${field.name} must be an http(s) link`);
    } else {
      output[field.name] = String(raw).slice(0, 4000);
    }
  }
  if (errors.length) return { ok: false, error: errors.join("; ") };
  return { ok: true, output };
}

/** The lines appended to an agent step's prompt telling it how to hand its output back. */
export function outputInstructions(fields) {
  if (!fields.length) return "When you are done, call the flow_step_output tool once with an empty object.";
  const lines = fields.map((field) => {
    const kind =
      field.type === "choice"
        ? `one of ${field.choices.join(", ")}`
        : field.type === "yes-no"
          ? "yes or no"
          : field.type === "number"
            ? "a number"
            : field.type === "link"
              ? "an http(s) link"
              : "text";
    return `- ${field.name}: ${kind}${field.description ? ` (${field.description})` : ""}`;
  });
  return ["When you are done, call the flow_step_output tool once with these fields:", ...lines].join("\n");
}

/** Short text for a step's output: "complexity large, area relay". */
export function outputSummary(output) {
  if (!isObject(output)) return "";
  return Object.entries(output)
    .filter(([, value]) => typeof value !== "string" || value.length <= 40)
    .slice(0, 3)
    .map(([key, value]) => `${key} ${typeof value === "boolean" ? (value ? "yes" : "no") : value}`)
    .join(", ");
}

// ---- words ------------------------------------------------------------------------------------------------------------

const TEST_WORDS = { is: "is", "is-not": "is not", contains: "contains", "is-set": "is set" };

/** An If's question: "If complexity is large". */
export function conditionText(step) {
  const field =
    String(step.field ?? "")
      .split(".")
      .at(-1) || "…";
  return step.test === "is-set" ? `If ${field} is set` : `If ${field} ${TEST_WORDS[step.test] ?? "is"} ${step.value || "…"}`;
}

/** The second line under a step's name in the editor. `modelName(provider, model)` names a model. */
export function stepSubtitle(step, { modelName } = {}) {
  switch (step.kind) {
    case "agent": {
      const parts = ["Agent"];
      if (step.model) parts.push(modelName?.(step.provider, step.model) ?? step.model);
      if (step.permissionMode === "auto") parts.push("Auto mode");
      else if (step.permissionMode === "full") parts.push("Full permission");
      else if (step.permissionMode === "ask") parts.push("asks approval");
      parts.push(step.chat === "own" ? "its own Chat" : "Run Chat");
      return parts.join(", ");
    }
    case "if":
      return `Condition, reads ${step.field || "a field"}`;
    case "ask":
      return `Approval, ${step.expiresInHours} h to answer, rejected or no answer ends the Run`;
    case "wait":
      if (step.until.kind === "time") return `Waits ${durationText(step.until.minutes)}`;
      if (step.until.kind === "linear-state") return `Waits until the issue is ${step.until.state}, up to ${step.timeoutHours} h`;
      return `Waits for a review, up to ${step.timeoutHours} h`;
    case "pull-request":
      return ["Action", step.askFirst ? "asks first" : "opens on its own", step.draft ? "draft PR" : "ready PR", "keeps a receipt"].join(", ");
    default:
      return "Action, posts once per Run";
  }
}

/** "45 min", "2 h", "1 h 30 min", "3 d". */
export function durationText(minutes) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** A step's title in lists: an If reads as its question. */
export function stepTitle(step) {
  return step.kind === "if" && (step.name === "If" || !step.name) ? conditionText(step) : step.name;
}

// ---- drafts -----------------------------------------------------------------------------------------------------------

const SETTING_WORDS = {
  prompt: "prompt changed",
  output: "output changed",
  model: "model changed",
  provider: "model changed",
  effort: "effort changed",
  permissionMode: "permissions changed",
  chat: "Chat changed",
  retries: "retries changed",
  onInvalid: "invalid output rule changed",
  field: "test changed",
  test: "test changed",
  value: "test changed",
  message: "message changed",
  expiresInHours: "time limit changed",
  until: "wait changed",
  timeoutHours: "time limit changed",
  title: "title changed",
  body: "text changed",
  base: "base branch changed",
  draft: "draft setting changed",
  askFirst: "approval setting changed",
  name: "renamed",
};

/** What a draft changes from the published steps, one line each: "Added Review", "Classify: prompt changed"… */
export function flowChanges(published, draft) {
  const before = new Map(flattenSteps(published ?? []).map((entry) => [entry.step.id, entry]));
  const after = new Map(flattenSteps(draft ?? []).map((entry) => [entry.step.id, entry]));
  const lines = [];
  for (const [id, entry] of after) {
    const old = before.get(id);
    if (!old) {
      lines.push(`Added ${stepTitle(entry.step)}`);
      continue;
    }
    const words = new Set();
    for (const key of new Set([...Object.keys(old.step), ...Object.keys(entry.step)])) {
      if (key === "yes" || key === "otherwise" || key === "id" || key === "kind") continue;
      if (JSON.stringify(old.step[key]) !== JSON.stringify(entry.step[key])) words.add(SETTING_WORDS[key] ?? `${key} changed`);
    }
    if (old.parentId !== entry.parentId || old.branch !== entry.branch || old.index !== entry.index) words.add("moved");
    for (const word of words) lines.push(`${stepTitle(entry.step)}: ${word}`);
  }
  for (const [id, entry] of before) if (!after.has(id)) lines.push(`Removed ${stepTitle(entry.step)}`);
  return lines;
}

// ---- a Run's progress -------------------------------------------------------------------------------------------------

/**
 * A flow Run's steps in run order with how each went, for the Run view: `status` is "not-taken" for a step on the path an
 * If didn't take, and a path's label row comes before its steps (`{ path: "yes" | "otherwise", parentId, taken }`).
 */
export function runRows(flow) {
  const rows = [];
  const state = flow?.state ?? {};
  const walk = (steps, depth, offPath) => {
    for (const step of steps) {
      const run = state[step.id];
      const status = offPath ? "not-taken" : (run?.status ?? "pending");
      rows.push({ kind: "step", step, depth, status, run: run ?? null });
      if (step.kind !== "if") continue;
      const taken = run?.taken ?? null;
      for (const path of ["yes", "otherwise"]) {
        const off = offPath || (taken !== null && taken !== path);
        rows.push({ kind: "path", path, parentId: step.id, depth: depth + 1, taken: taken === path, decided: taken !== null, empty: step[path].length === 0 });
        walk(step[path], depth + 1, off);
      }
    }
  };
  walk(flow?.steps ?? [], 0, false);
  return rows;
}

/** The step a Run is on: the first one running or waiting, else null. */
export function currentStep(flow) {
  for (const entry of flattenSteps(flow?.steps ?? [])) {
    const status = flow.state?.[entry.step.id]?.status;
    if (status === "running" || status === "waiting") return entry.step;
  }
  return null;
}

/** The step a Run stopped at, failed or not: the first failed one. */
export function failedStep(flow) {
  return flattenSteps(flow?.steps ?? []).find((entry) => flow.state?.[entry.step.id]?.status === "failed")?.step ?? null;
}

/** A Run's state in a few words: "Waiting for you at Open pull request", "Stopped at Implement", "Ended, approval expired". */
export function flowRunText(run) {
  const flow = run?.flow;
  if (!flow) return "";
  const current = currentStep(flow);
  if (flow.status === "paused") return current ? `Paused at ${stepTitle(current)}` : "Paused";
  if (flow.status === "waiting" && current) {
    const approval = flow.state[current.id]?.approval;
    return approval && !approval.decision ? `Waiting for you at ${stepTitle(current)}` : `Waiting at ${stepTitle(current)}`;
  }
  if (flow.status === "running") return current ? `Running ${stepTitle(current)}` : "Running";
  if (flow.status === "failed") {
    const failed = failedStep(flow);
    return failed ? `Stopped at ${stepTitle(failed)}` : "Stopped";
  }
  if (flow.status === "ended") return run.error ? `Ended, ${run.error}` : "Ended";
  return flow.dryRun ? "Test run done" : "Done";
}

/** Whether the Run waits on the owner: an approval with no answer yet. */
export function needsAnswer(run) {
  const flow = run?.flow;
  if (!flow || flow.status !== "waiting") return false;
  const current = currentStep(flow);
  const approval = current ? flow.state[current.id]?.approval : null;
  return Boolean(approval && !approval.decision);
}
