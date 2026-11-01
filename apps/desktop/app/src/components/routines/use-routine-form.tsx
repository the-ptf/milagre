import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelCapabilities, ModelOption, Routine, RoutineTrigger } from "@milagre/shared/model";
import { capabilityFor } from "@milagre/shared/model-options";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import { PROVIDERS, providerName } from "@milagre/shared/providers";
import { projectOfKey } from "@milagre/shared/agent-runs";
import { ipcErrorMessage } from "@milagre/shared/result";
import { placeholdersFor } from "@milagre/shared/routine-prompt";
import {
  EVERY_HOURS,
  EVERY_MINUTES,
  emptyRoutineForm,
  fallbackApplies,
  formFromRoutine,
  formToInput,
  formToUpdate,
  isCommentRoutine,
  scheduleCron,
  withRunIn,
  type RoutineFormField,
  type RoutineFormState,
} from "@milagre/shared/routine-form";
import { triggerChipText } from "@milagre/shared/routines";
import type { RoutineCreate, RoutineLinearOptions, RoutineTargets, RoutineUpdate } from "../../electron";
import type { SelectOption } from "../primitives/Select";
import { ProviderLogo } from "../ProviderLogo";
import { computerOfRoutine, useRoutines, type RoutineWithRuns } from "../../lib/routines";
import { bridgeFor, bridgeForKey } from "../../lib/computer-bridge";
import { useComputers } from "../../lib/computers";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";

export type HookInfo = { url: string; signed: boolean; signingHeader?: string };

/** What a save did: an edit saved, or a new Routine made (a webhook's with its new URL). */
export type RoutineSaved = { kind: "saved" } | { kind: "created"; routine: Routine; hookUrl?: string };

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The time zones a schedule can pick: the current one and this computer's first, then every zone Intl knows. */
export function timezones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return [...new Set([current, localZone(), "UTC", ...zones])];
}

/** The trigger the placeholder list is for: the form's kind with what it has chosen so far. */
function draftTrigger(state: RoutineFormState): RoutineTrigger {
  if (state.trigger === "linear") return { kind: "linear", workspace: state.linear.workspace, event: state.linear.event };
  if (state.trigger === "webhook") return { kind: "webhook", hookId: "", signed: false };
  return { kind: "schedule", cron: "", timezone: state.schedule.timezone };
}

/** The trigger chip's words for the form as it stands: the schedule it would save, else the Linear or webhook trigger. */
function draftTriggerText(state: RoutineFormState): string {
  if (state.trigger === "schedule") {
    const made = scheduleCron(state.schedule);
    return made.cron ? triggerChipText({ kind: "schedule", cron: made.cron, timezone: state.schedule.timezone }, localZone()) : "Schedule";
  }
  if (state.trigger === "linear")
    return triggerChipText({
      kind: "linear",
      workspace: state.linear.workspace,
      event: state.linear.event,
      ...(state.linear.team ? { team: state.linear.team } : {}),
      ...(state.linear.label ? { label: state.linear.label } : {}),
      ...(state.linear.state ? { state: state.linear.state } : {}),
    });
  return "Webhook";
}

const LINEAR_WHEN: SelectOption<RoutineFormState["linear"]["event"]>[] = [
  { value: "label-added", label: "Label added" },
  { value: "assigned", label: "Assigned to me" },
  { value: "state", label: "Moved to a state" },
  { value: "comment", label: "New comment" },
];

/**
 * The Routine form's state and everything it reads and saves, shared by the New Routine and Edit surfaces: the targets
 * of every computer with Routines on (only the edited Routine's own computer when editing) and Linear choices, a webhook's URL with Copy and Rotate, field errors, and the submit that sends
 * `routines:create` or `routines:update` (packages/shared/routine-form validates both).
 */
export function useRoutineForm({
  initial,
  models,
  capabilities = null,
  defaultProjectPath,
}: {
  initial?: RoutineWithRuns;
  models: ModelOption[];
  /** What each reported model accepts: the fallback's efforts come from here. */
  capabilities?: ModelCapabilities | null;
  defaultProjectPath?: string;
}) {
  const [state, setState] = useState<RoutineFormState>(() => {
    const zone = localZone();
    if (!initial) return { ...emptyRoutineForm(zone), projectPath: defaultProjectPath ?? "" };
    const form = formFromRoutine(initial, zone);
    return form.runIn === "chat" ? { ...form, projectPath: projectOfKey(form.chatId) } : form;
  });
  const [errors, setErrors] = useState<Partial<Record<RoutineFormField, string>>>({});
  const [topError, setTopError] = useState("");
  const [busy, setBusy] = useState(false);
  // Whether the user changed anything: leaving then asks to discard. Reads the form fills in itself don't count.
  const [dirty, setDirty] = useState(false);
  const [targets, setTargets] = useState<RoutineTargets | null>(null);
  const [linear, setLinear] = useState<RoutineLinearOptions | null>(null);
  const [hook, setHook] = useState<HookInfo | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  // The date picker's range starts from when the form opened.
  const [openedAt] = useState(() => Date.now());
  const editing = Boolean(initial);
  // Comments go into the Chat linked to their issue: no Project or Each Run to pick.
  const comment = isCommentRoutine(state);
  const heartbeat = state.runIn === "chat" && !comment;

  // Where a new Routine can run: this Mac and every computer whose Routines answered (creating one there lets it run
  // them). An edit stays on its Routine's computer.
  const { byComputer } = useRoutines();
  const { thisMac, computers } = useComputers();
  const remotesOn = computers.filter((computer) => typeof byComputer[computer.id]?.enabled === "boolean").map((computer) => computer.id);
  const sources = initial ? [computerOfRoutine(initial)] : [LOCAL_COMPUTER, ...remotesOn];
  const sourceKey = sources.join(",");
  useEffect(() => {
    let live = true;
    Promise.all(
      sources.map((id) =>
        Promise.resolve()
          .then(() => bridgeFor(id).routineTargets())
          .then((found) => ({ id, found })),
      ),
    )
      .then((read) => ({ projects: read.flatMap(({ found }) => found.projects) }))
      .then(
        (found: RoutineTargets) => {
          if (!live) return;
          setTargets(found);
          const first = found.projects[0]?.path;
          if (first) setState((current) => (current.projectPath ? current : { ...current, projectPath: first }));
        },
        (failure) => live && setTopError(ipcErrorMessage(failure)),
      );
    return () => {
      live = false;
    };
  }, [sourceKey]);
  // Linear's choices: labels and states belong to the picked team, so they are read again when it changes.
  // Linear is signed in per Mac: the choices come from the computer the Routine runs on.
  const { workspace, team } = state.linear;
  const linearComputer = initial ? computerOfRoutine(initial) : computerOfKey(state.projectPath);
  // Another Mac's Linear has its own workspaces and teams: picking a Project there starts the choice over.
  const linearFrom = useRef(linearComputer);
  useEffect(() => {
    if (linearFrom.current === linearComputer) return;
    linearFrom.current = linearComputer;
    setState((current) => ({ ...current, linear: { ...current.linear, workspace: "", team: "", label: "", state: "" } }));
  }, [linearComputer]);
  useEffect(() => {
    if (state.trigger !== "linear") return;
    let live = true;
    Promise.resolve()
      .then(() => bridgeFor(linearComputer).routineLinearOptions({ ...(workspace ? { workspace } : {}), ...(team ? { team } : {}) }))
      .then(
        (options) => {
          if (!live) return;
          setLinear(options);
          const first = options.workspaces[0];
          if (!workspace && first) setState((current) => ({ ...current, linear: { ...current.linear, workspace: first.id } }));
        },
        (failure) => live && setLinear({ workspaces: [], teams: [], labels: [], states: [], error: ipcErrorMessage(failure) }),
      );
    return () => {
      live = false;
    };
  }, [state.trigger, workspace, team, linearComputer]);
  useEffect(() => {
    if (!initial || initial.trigger.kind !== "webhook") return;
    let live = true;
    bridgeForKey(initial.id)
      .routineHook(initial.id)
      .then(
        (info) => {
          if (!live) return;
          setHook(info);
        },
        (failure) => live && setTopError(ipcErrorMessage(failure)),
      );
    return () => {
      live = false;
    };
  }, [initial?.id]);

  const update = (patch: Partial<RoutineFormState>) => {
    setDirty(true);
    setTopError("");
    setErrors({});
    setState((current) => ({ ...current, ...patch }));
  };
  const setRunIn = (runIn: RoutineFormState["runIn"]) => {
    setDirty(true);
    setErrors({});
    setState((current) => withRunIn(current, runIn));
  };
  /** A new Routine's trigger kind. Only a schedule can check back on a Chat; another trigger starts new Chats. */
  const setTrigger = (trigger: RoutineFormState["trigger"]) =>
    update({ trigger, runIn: trigger !== "schedule" && state.runIn === "chat" ? "worktree" : state.runIn });
  const placeholders = useMemo(() => placeholdersFor(draftTrigger(state)), [state]);
  const project = targets?.projects.find((entry) => entry.path === state.projectPath);

  /** Saves the form; a problem shows under its field and resolves null. */
  const submit = async (): Promise<RoutineSaved | null> => {
    const result = initial ? formToUpdate(state, initial) : formToInput(state);
    if (result.field !== undefined) {
      // A comment Routine shows no Project or Each Run, so their problems show under the Linear fields.
      setErrors({ [comment && ["project", "runIn", "chat"].includes(result.field) ? "workspace" : result.field]: result.error });
      return null;
    }
    setBusy(true);
    setTopError("");
    try {
      if (initial && "patch" in result) {
        await bridgeForKey(initial.id).updateRoutine(initial.id, result.patch as RoutineUpdate);
        return { kind: "saved" };
      }
      if ("input" in result) {
        // A webhook trigger goes without a hook id: the Mac mints the URL and answers with it. The target's computer runs it.
        const input = result.input as RoutineCreate;
        const made = await bridgeForKey(input.target.kind === "chat" ? input.target.chatId : input.target.projectPath).createRoutine(input);
        return { kind: "created", routine: made.routine, ...(made.hookUrl ? { hookUrl: made.hookUrl } : {}) };
      }
      return null;
    } catch (failure) {
      setTopError(ipcErrorMessage(failure));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const copy = (url: string) => {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(url))
      .then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
        () => setTopError("Couldn't copy the URL."),
      );
  };
  const rotate = async () => {
    if (!initial) return;
    setRotating(false);
    try {
      const { url } = await bridgeForKey(initial.id).rotateRoutineHook(initial.id);
      setHook((current) => ({ signed: current?.signed ?? false, ...current, url }));
    } catch (failure) {
      setTopError(ipcErrorMessage(failure));
    }
  };

  const modelOptions: SelectOption<string>[] = [
    { value: "", label: "Default model" },
    ...PROVIDERS.flatMap((provider) =>
      models
        .filter((model) => model.provider === provider)
        .map((model) => ({ value: model.id, label: model.name, icon: <ProviderLogo provider={provider} size={14} />, group: providerName(provider) })),
    ),
  ];
  // The model a failed Run retries on: automatic (another installed provider's recommended model) or one picked here.
  const fallbackOptions: SelectOption<string>[] = [
    { value: "", label: "Retry on another provider", description: "When a Run fails on its model, it retries once on another installed provider" },
    ...PROVIDERS.flatMap((provider) =>
      models
        .filter((model) => model.provider === provider)
        .map((model) => ({
          value: `${provider}:${model.id}`,
          label: `Retry on ${model.name}`,
          icon: <ProviderLogo provider={provider} size={14} />,
          group: providerName(provider),
        })),
    ),
  ];
  const fallbackModel = state.fallbackModel ? models.find((model) => model.provider === state.fallbackProvider && model.id === state.fallbackModel) : undefined;
  if (state.fallbackModel && !fallbackModel)
    fallbackOptions.push({ value: `${state.fallbackProvider}:${state.fallbackModel}`, label: `Retry on ${state.fallbackModel}` });
  const fallbackEfforts = fallbackModel ? capabilityFor(fallbackModel, capabilities).efforts : [];
  const fallbackEffortOptions: SelectOption<string>[] = [
    { value: "", label: "Default effort" },
    ...fallbackEfforts.map((effort) => ({ value: effort, label: `${effort[0]!.toUpperCase()}${effort.slice(1)} effort` })),
  ];
  if (state.fallbackEffort && !fallbackEfforts.includes(state.fallbackEffort))
    fallbackEffortOptions.push({ value: state.fallbackEffort, label: `${state.fallbackEffort} effort` });
  const modeOptions: SelectOption<string>[] = [
    { value: "", label: "Default mode" },
    ...PERMISSION_MODES.map((mode) => ({ value: mode.id, label: mode.name, description: mode.description })),
  ];
  // With other computers, each Project is listed under the computer it is on.
  const computerName = (id: string) => (id === LOCAL_COMPUTER ? thisMac : (computers.find((computer) => computer.id === id)?.name ?? "Computer"));
  const projectOptions: SelectOption<string>[] = (targets?.projects ?? []).map((entry) => ({
    value: entry.path,
    label: entry.name,
    ...(computers.length > 0 ? { group: computerName(computerOfKey(entry.path)) } : {}),
  }));
  if (state.projectPath && !projectOptions.some((option) => option.value === state.projectPath))
    projectOptions.unshift({ value: state.projectPath, label: state.projectPath.split("/").at(-1) ?? state.projectPath });
  const chatOptions: SelectOption<string>[] = (project?.chats ?? []).map((chat) => ({ value: chat.chatId, label: chat.title || "Untitled Chat" }));
  if (state.chatId && !chatOptions.some((option) => option.value === state.chatId)) chatOptions.unshift({ value: state.chatId, label: "This Chat" });
  const runInOptions: SelectOption<RoutineFormState["runIn"]>[] = [
    { value: "worktree", label: "New Worktree", description: "A new Chat in its own Worktree", disabled: editing && heartbeat },
    { value: "project", label: "Project folder", description: "A new Chat in the Project folder", disabled: editing && heartbeat },
    {
      value: "chat",
      label: "An existing Chat",
      description: state.trigger === "schedule" ? "A Heartbeat that checks back on one Chat" : "Schedules only",
      disabled: state.trigger !== "schedule" || (editing && !heartbeat),
    },
  ];
  const stopOptions: SelectOption<RoutineFormState["stop"]["kind"]>[] = [
    { value: "never", label: "Never", disabled: heartbeat },
    { value: "runs", label: "After a number of Runs" },
    { value: "date", label: "On a date" },
  ];
  const minutes = EVERY_MINUTES as readonly number[];
  const hours = EVERY_HOURS as readonly number[];
  const projectName = project?.name ?? (state.projectPath ? (state.projectPath.split("/").at(-1) ?? state.projectPath) : "");
  const chatTitle = chatOptions.find((option) => option.value === state.chatId)?.label;
  const whereText = heartbeat ? `In ${chatTitle ?? "a Chat"}` : `New ${state.runIn === "worktree" ? "Worktree" : "Chat"} in ${projectName || "a Project"}`;

  return {
    state,
    setState,
    update,
    setRunIn,
    setTrigger,
    errors,
    topError,
    busy,
    dirty,
    targets,
    linear,
    hook,
    rotating,
    setRotating,
    copied,
    copy,
    rotate,
    submit,
    openedAt,
    editing,
    comment,
    heartbeat,
    placeholders,
    whereText,
    triggerText: draftTriggerText(state),
    // Only a Run in a Chat of its own retries; a Heartbeat's beat and a Linear comment run on their Chat's model.
    fallback: fallbackApplies(state),
    fallbackValue: state.fallbackModel ? `${state.fallbackProvider}:${state.fallbackModel}` : "",
    // Picking another model drops an effort it doesn't take.
    setFallback: (value: string) => {
      const split = value.indexOf(":");
      const provider = (split > 0 ? value.slice(0, split) : "") as RoutineFormState["fallbackProvider"];
      const model = split > 0 ? value.slice(split + 1) : "";
      const picked = models.find((item) => item.provider === provider && item.id === model);
      const efforts = picked ? capabilityFor(picked, capabilities).efforts : [];
      update({ fallbackProvider: provider, fallbackModel: model, fallbackEffort: efforts.includes(state.fallbackEffort) ? state.fallbackEffort : "" });
    },
    ready: state.name.trim().length > 0 && state.prompt.trim().length > 0,
    options: {
      model: modelOptions,
      fallback: fallbackOptions,
      fallbackEffort: fallbackEfforts.length > 0 || state.fallbackEffort ? fallbackEffortOptions : null,
      mode: modeOptions,
      project: projectOptions,
      chat: chatOptions,
      runIn: runInOptions,
      stop: stopOptions,
      linearWhen: LINEAR_WHEN,
    },
    every: { minutes, hours },
  };
}

export type RoutineFormApi = ReturnType<typeof useRoutineForm>;
