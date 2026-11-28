const path = require("node:path");
const { z } = require("zod");
const { clock, triggerText } = require("@milagre/shared/routines");
const { projectOfKey } = require("@milagre/shared/agent-runs");
const { PROVIDERS } = require("@milagre/shared/providers");
const { everyToCron } = require("./cron.cjs");

const ROUTINE_TOOL_NAMES = Object.freeze(["routine_list", "heartbeat_create", "routine_create", "routine_update", "routine_delete", "routine_run_now"]);
const [ROUTINE_LIST, HEARTBEAT_CREATE, ROUTINE_CREATE, ROUTINE_UPDATE, ROUTINE_DELETE, ROUTINE_RUN_NOW] = ROUTINE_TOOL_NAMES;

const UNIT_MS = { m: 60_000, h: 3600_000, d: 864e5 };
const MAX_EXPIRY_MS = 30 * 864e5;

const cronField = z.string().max(100).describe('Five-field cron expression, e.g. "0 9 * * 1-5". Give this or every, not both.');
const everyField = z
  .string()
  .max(10)
  .describe(
    'A fixed cadence: minutes that divide 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30) with m, or hours that divide 24 (1, 2, 3, 4, 6, 8, 12, 24) with h, e.g. "15m" or "2h". Give this or cron, not both.',
  );
const timezoneField = z.string().max(64).describe("IANA timezone, e.g. America/Sao_Paulo. Defaults to the computer's timezone.");
const maxRunsField = z.number().int().min(1).max(1000).describe("End the Heartbeat after this many Runs.");
const expiresInField = z.string().max(10).describe('End the Heartbeat after this long: a number and m, h or d, e.g. "12h" or "3d". At most 30d.');
const projectPathField = z
  .string()
  .min(1)
  .max(8192)
  .optional()
  .describe(
    "Another Project on this computer, by its path from project_list. Left out, this Chat's Project. Unless this Chat runs in Full permission or already has access to it, the user approves first on a card in this Chat: wait for its result.",
  );
const OUTSIDE_REFUSED = "Routines in other Projects are unavailable here.";

function expiresInMs(value) {
  const match = /^(\d+)([mhd])$/.exec(value);
  if (!match || Number(match[1]) < 1) throw new Error(`Invalid expiresIn: ${JSON.stringify(value)} (use e.g. 30m, 6h or 7d)`);
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  if (ms > MAX_EXPIRY_MS) throw new Error(`expiresIn ${JSON.stringify(value)} is too long: a Heartbeat runs for at most 30d`);
  return ms;
}

function checkTimezone(timeZone) {
  Intl.DateTimeFormat("en-US", { timeZone }).format(0);
}

function endText(routine) {
  const ends = [];
  if (routine.expiresAt !== undefined) ends.push(clock(routine.expiresAt, routine.trigger.timezone, true));
  if (routine.maxRuns !== undefined) ends.push(`after ${routine.maxRuns} ${routine.maxRuns === 1 ? "run" : "runs"}`);
  return ends.length ? `ends ${ends.join(" or ")}` : "no end";
}

const nextText = (routine) => (routine.enabled && routine.nextRunAt != null ? clock(routine.nextRunAt, routine.trigger.timezone, false) : "-");

function summary(routine) {
  const next = routine.trigger.kind !== "schedule" ? (routine.enabled ? "on" : "paused") : routine.enabled ? `next ${nextText(routine)}` : "paused";
  return `${triggerText(routine.trigger)}, ${next}, ${endText(routine)}`;
}

const LINEAR_EVENTS = ["assigned", "label-added", "state", "comment"];

const FALLBACK_HINT =
  "When a Run fails for a provider-side reason (model at capacity, rate or usage limit, the agent exiting unexpectedly), Milagre retries it once, right away, on this model. Without one it retries on another installed provider's recommended model.";
const fallbackFields = (clearable) => ({
  fallbackProvider: (clearable ? z.enum(PROVIDERS).nullable() : z.enum(PROVIDERS))
    .optional()
    .describe(`The provider a failed Run retries on; give it with fallbackModel. ${clearable ? "null goes back to the automatic pick. " : ""}${FALLBACK_HINT}`),
  fallbackModel: z.string().min(1).max(200).optional().describe("The model id the retry runs on, as the model picker lists it."),
  fallbackEffort: z.string().min(1).max(40).optional().describe("The retry's effort, e.g. medium or high; the model's default when left out."),
});

function fallbackOf({ fallbackProvider, fallbackModel, fallbackEffort }) {
  if (fallbackProvider === null) {
    if (fallbackModel !== undefined || fallbackEffort !== undefined)
      throw new Error("fallbackProvider null clears the fallback: leave out fallbackModel and fallbackEffort.");
    return null;
  }
  if (fallbackProvider === undefined && fallbackModel === undefined && fallbackEffort === undefined) return undefined;
  if (fallbackProvider === undefined || fallbackModel === undefined) throw new Error("Give fallbackProvider and fallbackModel together.");
  return { provider: fallbackProvider, model: fallbackModel, ...(fallbackEffort !== undefined ? { effort: fallbackEffort } : {}) };
}

const fallbackText = (routine) =>
  routine.fallback
    ? `${routine.fallback.provider} ${routine.fallback.model}${routine.fallback.effort ? ` (${routine.fallback.effort})` : ""}`
    : "another installed provider's recommended model";

function linearTrigger(trigger, { linearEvent, team, label, state }) {
  if (trigger.kind !== "linear") throw new Error("Only a Linear trigger has linearEvent, team, label or state.");
  const event = linearEvent ?? trigger.event;
  if (label !== undefined && event !== "label-added") throw new Error("A label goes with linearEvent label-added.");
  if (state !== undefined && event !== "state") throw new Error("A state goes with linearEvent state.");
  const next = { kind: "linear", workspace: trigger.workspace, event };
  const keptTeam = team === undefined ? trigger.team : team || undefined;
  if (keptTeam !== undefined) next.team = keptTeam;
  if (event === "label-added") {
    next.label = label ?? trigger.label;
    if (next.label === undefined) throw new Error("linearEvent label-added needs a label.");
  }
  if (event === "state") {
    next.state = state ?? trigger.state;
    if (next.state === undefined) throw new Error("linearEvent state needs a state.");
  }
  return next;
}

function createRoutineTools({
  store,
  scheduler,
  chatSettings,
  defaultTimezone,
  linearWorkspaces = () => [],
  checkTarget = async (target) => target,
  remove = (routineId) => store.remove(routineId),
  keepChat = async () => {},
  now = Date.now,
}) {
  function definitions(
    chatId,
    {
      babysitOnly = false,
      reachProject = async () => {
        throw new Error(OUTSIDE_REFUSED);
      },
    } = {},
  ) {
    const project = projectOfKey(chatId);
    const inProjectOf = (projectPath) => (routine) =>
      routine.target?.kind === "chat"
        ? projectOfKey(routine.target.chatId) === projectPath
        : routine.target?.kind === "new-chat" && routine.target.projectPath === projectPath;
    const inProject = babysitOnly ? (routine) => routine.trigger.kind === "pull-request" && routine.target?.chatId === chatId : inProjectOf(project);
    if (babysitOnly && !store.list().some((routine) => !routine.completedAt && inProject(routine))) return [];
    const reached = async (projectPath) => {
      if (projectPath === undefined || projectPath === project) return inProject;
      await reachProject(projectPath);
      return inProjectOf(projectPath);
    };
    const notFound = (id, projectPath) => {
      if (projectPath !== undefined) return `Routine not found in ${projectPath}: ${id}`;
      return babysitOnly ? `Routine not found: ${id}` : `Routine not found: ${id}. For one in another Project, give its projectPath.`;
    };
    const own = async (id, projectPath) => {
      const routine = store.get(id);
      if (!routine || !(await reached(projectPath))(routine)) throw new Error(notFound(id, projectPath));
      return routine;
    };
    const elsewhere = babysitOnly ? {} : { projectPath: projectPathField };
    const tools = [
      {
        name: ROUTINE_LIST,
        description:
          "List the Routines (Heartbeats and triggers) in this Chat's Project, or in another Project with projectPath: id, name, trigger, next run and whether it is enabled.",
        input: { ...elsewhere },
        readOnly: true,
        run: async ({ projectPath }) => {
          const lines = store
            .list()
            .filter(await reached(projectPath))
            .map((routine) => [routine.id, routine.name, triggerText(routine.trigger), nextText(routine), routine.enabled ? "enabled" : "paused"].join(" · "));
          if (lines.length) return lines.join("\n");
          return projectPath === undefined || projectPath === project ? "No Routines in this Project." : `No Routines in ${path.basename(projectPath)}.`;
        },
      },
      {
        name: HEARTBEAT_CREATE,
        description:
          'Set a Heartbeat: Milagre sends the prompt into this Chat on a schedule, as a new turn, so you can keep watching something (a PR, a deploy, a long job). Give exactly one of cron or every. Give it its end now with expiresIn or maxRuns (at most 30 days; with neither it stops after 7 days), since deleting it later may need the user\'s approval. Setting one with the same name again replaces it. On a beat where nothing needs doing, reply "(pass) <reason>". Once the work is done (the PR is merged, the deploy is live), delete it with routine_delete.',
        input: {
          name: z.string().min(1).max(80).describe("Short name, unique in this Chat."),
          prompt: z.string().min(1).max(4000).describe("What to do on each beat."),
          cron: cronField.optional(),
          every: everyField.optional(),
          timezone: timezoneField.optional(),
          maxRuns: maxRunsField.optional(),
          expiresIn: expiresInField.optional(),
        },
        readOnly: false,
        run: async ({ name, prompt, cron, every, timezone, maxRuns, expiresIn }) => {
          if ((cron === undefined) === (every === undefined)) throw new Error("Give exactly one of cron or every, not both and not neither.");
          if (expiresIn !== undefined) expiresInMs(expiresIn);
          checkTimezone(timezone ?? defaultTimezone());
          const settings = chatSettings(chatId) ?? {};
          const { chatId: target } = await checkTarget({ kind: "chat", chatId });
          const routine = store.upsertHeartbeat({
            chatId: target,
            name,
            prompt,
            cron,
            every,
            timezone: timezone ?? defaultTimezone(),
            maxRuns,
            expiresIn,
            provider: settings.provider,
            model: settings.model,
            permissionMode: settings.permissionMode,
            createdBy: { kind: "agent", chatId },
          });
          await keepChat(routine.target.chatId);
          return `${JSON.stringify({ routine: { id: routine.id, name: routine.name } })}\nHeartbeat "${routine.name}" set: ${summary(routine)}. Reply "(pass) <reason>" on beats where nothing needs doing.`;
        },
      },
      {
        name: ROUTINE_CREATE,
        description:
          'Set a Routine: Milagre starts a fresh Chat in this Project on a schedule or when something happens in Linear. Each Run starts a new Chat (in a new Worktree unless projectWorkspace is "project"), not this one. Use heartbeat_create instead to message this Chat. trigger "schedule" needs exactly one of cron or every. trigger "linear" needs linearEvent (assigned, label-added, state or comment), plus label for label-added and state for state; team and workspace are optional. Webhook Routines can only be set up by the person in the New Routine form, because agents cannot create webhooks.',
        input: {
          name: z.string().min(1).max(80).describe("Short name."),
          prompt: z.string().min(1).max(4000).describe("What each Run's Chat should do."),
          trigger: z.enum(["schedule", "linear"]).describe("What starts a Run."),
          cron: cronField.optional(),
          every: everyField.optional(),
          timezone: timezoneField.optional(),
          linearEvent: z.enum(LINEAR_EVENTS).optional().describe("For a linear trigger: what happens to an issue."),
          team: z.string().min(1).max(80).optional().describe("For a linear trigger: only issues of this team key."),
          label: z.string().min(1).max(80).optional().describe("For linearEvent label-added: the label."),
          state: z.string().min(1).max(80).optional().describe("For linearEvent state: the state the issue moves to."),
          workspace: z.string().min(1).max(80).optional().describe("The Linear workspace. Needed only when several are connected."),
          projectWorkspace: z.enum(["worktree", "project"]).optional().describe("Where a Run works: a new Worktree (default) or the Project folder."),
          ...fallbackFields(false),
        },
        readOnly: false,
        run: async ({ name, prompt, trigger, cron, every, timezone, linearEvent, team, label, state, workspace, projectWorkspace, ...fallbackInput }) => {
          const fallback = fallbackOf(fallbackInput);
          let built;
          if (trigger === "schedule") {
            if ((cron === undefined) === (every === undefined)) throw new Error("Give exactly one of cron or every, not both and not neither.");
            const zone = timezone ?? defaultTimezone();
            checkTimezone(zone);
            built = { kind: "schedule", cron: cron ?? everyToCron(every), timezone: zone };
          } else {
            if (linearEvent === undefined) throw new Error(`A linear trigger needs linearEvent: ${LINEAR_EVENTS.join(", ")}.`);
            if (linearEvent === "label-added" && label === undefined) throw new Error("linearEvent label-added needs a label.");
            if (linearEvent === "state" && state === undefined) throw new Error("linearEvent state needs a state.");
            let chosen = workspace;
            if (chosen === undefined) {
              const connected = linearWorkspaces();
              if (connected.length !== 1) throw new Error("Say which Linear workspace");
              chosen = connected[0];
            }
            built = {
              kind: "linear",
              workspace: chosen,
              event: linearEvent,
              ...(team !== undefined ? { team } : {}),
              ...(linearEvent === "label-added" ? { label } : {}),
              ...(linearEvent === "state" ? { state } : {}),
            };
          }
          const settings = chatSettings(chatId) ?? {};
          const mode = projectWorkspace ?? "worktree";
          const target = await checkTarget({ kind: "new-chat", projectPath: project, workspace: mode });
          const routine = store.create({
            name,
            prompt,
            trigger: built,
            target,
            provider: settings.provider,
            model: settings.model,
            permissionMode: settings.permissionMode,
            ...(fallback ? { fallback } : {}),
            createdBy: { kind: "agent", chatId },
          });
          const where = mode === "project" ? "in the Project folder" : "in a new Worktree";
          return `Routine "${routine.name}" set: ${triggerText(routine.trigger)}, runs ${where} in ${path.basename(project)}${routine.fallback ? `, retries on ${fallbackText(routine)}` : ""}.`;
        },
      },
      {
        name: ROUTINE_UPDATE,
        description:
          "Change a Routine in this Chat's Project, or in another Project with projectPath: its name, prompt, schedule (cron or every), timezone, end (maxRuns or expiresIn), a Linear trigger's linearEvent, team, label or state, the fallback model a failed Run retries on, or pause it with enabled false. A Linear trigger keeps the filters you don't give; label-added needs a label and state needs a state.",
        input: {
          id: z.string().min(1).max(64),
          ...elsewhere,
          name: z.string().min(1).max(80).optional(),
          prompt: z.string().min(1).max(4000).optional(),
          cron: cronField.optional(),
          every: everyField.optional(),
          timezone: timezoneField.optional(),
          maxRuns: maxRunsField.optional(),
          expiresIn: expiresInField.optional(),
          enabled: z.boolean().optional(),
          linearEvent: z.enum(LINEAR_EVENTS).optional().describe("For a linear trigger: what happens to an issue."),
          team: z.string().max(80).nullable().optional().describe('For a linear trigger: only issues of this team key. null or "" clears it.'),
          label: z.string().min(1).max(80).optional().describe("For linearEvent label-added: the label."),
          state: z.string().min(1).max(80).optional().describe("For linearEvent state: the state the issue moves to."),
          ...fallbackFields(true),
        },
        readOnly: false,
        run: async ({ id, projectPath, every, expiresIn, linearEvent, team, label, state, fallbackProvider, fallbackModel, fallbackEffort, ...rest }) => {
          const current = await own(id, projectPath);
          const fallback = fallbackOf({ fallbackProvider, fallbackModel, fallbackEffort });
          if (rest.cron !== undefined && every !== undefined) throw new Error("Give cron or every, not both.");
          if (rest.timezone !== undefined) checkTimezone(rest.timezone);
          const patch = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
          if (every !== undefined) patch.cron = everyToCron(every);
          if (expiresIn !== undefined) patch.expiresAt = now() + expiresInMs(expiresIn);
          if ([linearEvent, team, label, state].some((value) => value !== undefined))
            patch.trigger = linearTrigger(current.trigger, { linearEvent, team, label, state });
          if (fallback !== undefined) patch.fallback = fallback;
          const routine = store.update(id, patch);
          if (routine.target?.kind === "chat") await keepChat(routine.target.chatId);
          return `Updated "${routine.name}": ${summary(routine)}${fallback !== undefined ? `, retries on ${fallbackText(routine)}` : ""}.`;
        },
      },
      {
        name: ROUTINE_DELETE,
        description: `Delete a Routine in this Chat's Project${babysitOnly ? "" : ", or in another Project with projectPath"}, such as a Heartbeat whose work is done. This may need the user's approval.`,
        input: { id: z.string().min(1).max(64), ...elsewhere },
        readOnly: false,
        run: async ({ id, projectPath }) => {
          const routine = await own(id, projectPath);
          remove(id, { byChat: chatId });
          return `Deleted "${routine.name}".`;
        },
      },
      {
        name: ROUTINE_RUN_NOW,
        description:
          "Run a Routine now, outside its schedule, and report how the Run went: one in this Chat's Project, or in another Project with projectPath.",
        input: { id: z.string().min(1).max(64), ...elsewhere },
        readOnly: false,
        run: async ({ id, projectPath }) => {
          const routine = await own(id, projectPath);
          const run = await scheduler.runNow(id);
          const detail = run?.error ?? run?.summary;
          return `Ran "${routine.name}": ${run?.status ?? "unknown"}.${detail ? ` ${detail}` : ""}`;
        },
      },
    ];
    return babysitOnly ? tools.filter((tool) => tool.name === ROUTINE_DELETE) : tools;
  }
  return { definitions };
}

module.exports = { ROUTINE_TOOL_NAMES, createRoutineTools };
