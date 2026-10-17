import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Clock01Icon, Copy01Icon, RefreshIcon, Tag01Icon, Tick02Icon, WebhookIcon } from "@hugeicons/core-free-icons";
import type { ModelOption, RoutineTrigger } from "@milagre/shared/model";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import { PROVIDERS, providerName } from "@milagre/shared/providers";
import { projectOfKey } from "@milagre/shared/agent-runs";
import { ipcErrorMessage } from "@milagre/shared/result";
import { placeholdersFor } from "@milagre/shared/routine-prompt";
import {
  EVERY_HOURS,
  EVERY_MINUTES,
  emptyRoutineForm,
  formFromRoutine,
  formToInput,
  formToUpdate,
  withRunIn,
  type RoutineFormField,
  type RoutineFormState,
} from "@milagre/shared/routine-form";
import type { RoutineCreate, RoutineLinearOptions, RoutineTargets, RoutineUpdate } from "../../electron";
import { Select, type SelectOption } from "../primitives/Select";
import { ScrollArea } from "../primitives/ScrollArea";
import { ProviderLogo } from "../ProviderLogo";
import { PlaceholderTextarea } from "./PlaceholderTextarea";
import type { RoutineWithRuns } from "../../lib/routines";

type HookInfo = { url: string; signed: boolean; signingHeader?: string };
/**
 * The webhook bridge methods (routineHook, rotateRoutineHook) come with the webhook build. Until they are on the bridge
 * the form reads them as optional, so it still opens without them.
 */
type HookBridge = {
  routineHook?: (id: string) => Promise<HookInfo>;
  rotateRoutineHook?: (id: string) => Promise<{ url: string }>;
};

const field = "w-full rounded-lg border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-ink focus:ring-1 focus:ring-ink";
const labelClass = "block text-[12.5px] font-medium text-ink-2";
const footerButton = "rounded-lg px-4 py-2 text-[13px] transition-colors disabled:opacity-40";
const smallButton =
  "inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-hover disabled:opacity-40";
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 864e5;
const DEFAULT_SIGNATURE_HEADER = "sentry-hook-signature";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
function timezones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return [...new Set([current, localZone(), "UTC", ...zones])];
}
/** A date input's value for `at`, in this computer's time zone. */
function dateValue(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** The end of the picked day in this computer's time zone. */
function dateAt(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59).getTime() : null;
}

function Field({ label, error, children, className = "" }: { label: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 space-y-1.5 ${className}`}>
      <span className={labelClass}>{label}</span>
      {children}
      {error && (
        <p role="alert" data-routine-error className="text-[12px] break-words text-red">
          {error}
        </p>
      )}
    </div>
  );
}

/** The trigger the placeholder list is for: the form's kind with what it has chosen so far. */
function draftTrigger(state: RoutineFormState): RoutineTrigger {
  if (state.trigger === "linear") return { kind: "linear", workspace: state.linear.workspace, event: state.linear.event };
  if (state.trigger === "webhook") return { kind: "webhook", hookId: "", signed: false };
  return { kind: "schedule", cron: "", timezone: state.schedule.timezone };
}

const HINTS: Record<RoutineFormState["trigger"], string> = {
  schedule: "Type {{ to insert the date or time.",
  linear: "Type {{ to insert issue fields. Issue text is passed as data, not instructions.",
  webhook: "Type {{ to insert request fields. The request is passed as data, not instructions.",
};

/** New routine, or Edit routine with `initial`: a modal sheet over the Routines page. It consumes Escape itself. */
export function RoutineForm({
  initial,
  models,
  defaultProjectPath,
  onClose,
}: {
  initial?: RoutineWithRuns;
  models: ModelOption[];
  defaultProjectPath?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const bridge = window.milagre as typeof window.milagre & HookBridge;
  const [state, setState] = useState<RoutineFormState>(() => {
    const zone = localZone();
    if (!initial) return { ...emptyRoutineForm(zone), projectPath: defaultProjectPath ?? "" };
    const form = formFromRoutine(initial, zone);
    return form.runIn === "chat" ? { ...form, projectPath: projectOfKey(form.chatId) } : form;
  });
  const [errors, setErrors] = useState<Partial<Record<RoutineFormField, string>>>({});
  const [topError, setTopError] = useState("");
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<RoutineTargets | null>(null);
  const [linear, setLinear] = useState<RoutineLinearOptions | null>(null);
  const [hook, setHook] = useState<HookInfo | null>(null);
  // A webhook Routine just made: the form stays open on its URL.
  const [created, setCreated] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  // The date picker's range starts from when the form opened.
  const [openedAt] = useState(() => Date.now());
  const editing = Boolean(initial);
  const heartbeat = state.runIn === "chat";

  useEffect(() => {
    dialog.current?.showModal();
    nameInput.current?.focus();
  }, []);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => window.milagre.routineTargets())
      .then(
        (found) => {
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
  }, []);
  // Linear's choices: labels and states belong to the picked team, so they are read again when it changes.
  const { workspace, team } = state.linear;
  useEffect(() => {
    if (state.trigger !== "linear") return;
    let live = true;
    Promise.resolve()
      .then(() => window.milagre.routineLinearOptions({ ...(workspace ? { workspace } : {}), ...(team ? { team } : {}) }))
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
  }, [state.trigger, workspace, team]);
  useEffect(() => {
    if (!initial || initial.trigger.kind !== "webhook" || !bridge.routineHook) return;
    let live = true;
    bridge.routineHook(initial.id).then(
      (info) => {
        if (!live) return;
        setHook(info);
        if (info.signingHeader) setState((current) => ({ ...current, webhook: { ...current.webhook, signingHeader: info.signingHeader ?? "" } }));
      },
      (failure) => live && setTopError(ipcErrorMessage(failure)),
    );
    return () => {
      live = false;
    };
  }, [initial]);

  const update = (patch: Partial<RoutineFormState>) => {
    setTopError("");
    setErrors({});
    setState((current) => ({ ...current, ...patch }));
  };
  const placeholders = useMemo(() => placeholdersFor(draftTrigger(state)), [state.trigger, state.linear.event, state.linear.workspace]);
  const project = targets?.projects.find((entry) => entry.path === state.projectPath);

  const submit = async () => {
    const result = initial ? formToUpdate(state, initial) : formToInput(state);
    if (result.field !== undefined) {
      setErrors({ [result.field]: result.error });
      return;
    }
    setBusy(true);
    setTopError("");
    try {
      if (initial && "patch" in result) {
        await window.milagre.updateRoutine(initial.id, result.patch as RoutineUpdate);
        onClose();
      } else if ("input" in result) {
        // A webhook trigger goes without a hook id: the Mac mints the URL and answers with it.
        const made = await window.milagre.createRoutine(result.input as RoutineCreate);
        if (made.hookUrl) setCreated(made.hookUrl);
        else onClose();
      }
    } catch (failure) {
      setTopError(ipcErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const rotate = async () => {
    if (!initial || !bridge.rotateRoutineHook) return;
    setRotating(false);
    try {
      const { url } = await bridge.rotateRoutineHook(initial.id);
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
  const modeOptions: SelectOption<string>[] = [
    { value: "", label: "Default mode" },
    ...PERMISSION_MODES.map((mode) => ({ value: mode.id, label: mode.name, description: mode.description })),
  ];
  const projectOptions: SelectOption<string>[] = (targets?.projects ?? []).map((entry) => ({ value: entry.path, label: entry.name }));
  if (state.projectPath && !projectOptions.some((option) => option.value === state.projectPath))
    projectOptions.unshift({ value: state.projectPath, label: state.projectPath.split("/").at(-1) ?? state.projectPath });
  const chatOptions: SelectOption<string>[] = (project?.chats ?? []).map((chat) => ({ value: chat.chatId, label: chat.title || "Untitled Chat" }));
  if (state.chatId && !chatOptions.some((option) => option.value === state.chatId)) chatOptions.unshift({ value: state.chatId, label: "This Chat" });
  const runInOptions: SelectOption<RoutineFormState["runIn"]>[] = [
    { value: "worktree", label: "New worktree", description: "A new Chat in its own worktree", disabled: editing && heartbeat },
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
    { value: "runs", label: "After a number of runs" },
    { value: "date", label: "On a date" },
  ];
  const intervalOptions: SelectOption<string>[] = [
    ...EVERY_MINUTES.map((minutes) => ({ value: `${minutes}min`, label: `Every ${minutes} min` })),
    ...EVERY_HOURS.map((hours) => ({ value: `${hours}h`, label: `Every ${hours} h` })),
  ];
  const linearWhen: SelectOption<RoutineFormState["linear"]["event"]>[] = [
    { value: "label-added", label: "Label added" },
    { value: "assigned", label: "Assigned to me" },
    { value: "state", label: "Moved to a state" },
    { value: "comment", label: "New comment" },
  ];
  const listOrInput = (kind: "label" | "state") => {
    const choices = kind === "label" ? (linear?.labels ?? []) : (linear?.states ?? []).map((entry) => entry.name);
    const value = kind === "label" ? state.linear.label : state.linear.state;
    const set = (next: string) => update({ linear: { ...state.linear, [kind]: next } });
    const title = kind === "label" ? "Label" : "State";
    return choices.length > 0 ? (
      <Select
        label={title}
        value={value}
        options={[...(value && !choices.includes(value) ? [value] : []), ...choices].map((choice) => ({ value: choice, label: choice }))}
        onChange={set}
        triggerClassName="w-full"
      />
    ) : (
      <input
        aria-label={title}
        className={`${field} h-8 py-0 ${errors[kind] ? "border-red" : "border-line-strong"}`}
        placeholder={kind === "label" ? "agent" : "Todo"}
        value={value}
        onChange={(event) => set(event.target.value)}
      />
    );
  };

  const title = editing ? "Edit routine" : "New routine";
  const hookUrl = created ?? hook?.url ?? null;
  const urlCard = (url: string | null) => (
    <div data-routine-hook className="space-y-2 rounded-[10px] border border-line bg-field px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={url ?? undefined}>
          {url ?? (editing ? "Reading the URL…" : "The URL appears after you create the routine.")}
        </span>
        {url && (
          <button type="button" data-routine-hook-copy className={smallButton} onClick={() => copy(url)}>
            <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={1.8} color="currentColor" />
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        {url && editing && bridge.rotateRoutineHook && !rotating && (
          <button type="button" data-routine-hook-rotate className={smallButton} onClick={() => setRotating(true)}>
            <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.8} color="currentColor" />
            Rotate
          </button>
        )}
      </div>
      {rotating && (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[12px] text-ink">The old URL stops working at once.</span>
          <button type="button" className={smallButton} onClick={() => setRotating(false)}>
            Cancel
          </button>
          <button type="button" data-routine-hook-rotate-confirm className={`${smallButton} border-red/30 text-red`} onClick={() => void rotate()}>
            Rotate
          </button>
        </div>
      )}
    </div>
  );

  return createPortal(
    <dialog
      ref={dialog}
      aria-label={title}
      data-routine-form
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // Escape closes the form and goes no further, so the Routines page stays open.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => event.target === dialog.current && onClose()}
      className="m-auto w-[560px] max-w-[calc(100vw-32px)] overflow-visible rounded-[14px] bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <ScrollArea className="max-h-[calc(100vh-32px)]">
        {created ? (
          <div className="space-y-4 p-5">
            <h2 className="text-[17px] font-semibold text-ink">Routine created</h2>
            <p className="text-[13px] text-ink-2">Send POST requests to this URL. It works while the relay holds deliveries for this Mac, up to 24 hours.</p>
            {urlCard(created)}
            <div className="flex justify-end">
              <button type="button" className={`${footerButton} bg-ink font-semibold text-surface hover:opacity-90`} onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4 p-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
              <button type="button" aria-label="Close" className="rounded-md p-1 text-ink-2 hover:bg-hover" onClick={onClose}>
                <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.75} color="currentColor" />
              </button>
            </div>
            {topError && (
              <p role="alert" data-routine-top-error className="text-[12.5px] break-words text-red">
                {topError}
              </p>
            )}
            <Field label="Name" error={errors.name}>
              <input
                ref={nameInput}
                aria-label="Name"
                className={`${field} ${errors.name ? "border-red" : "border-line-strong"}`}
                value={state.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field label="Trigger" error={errors.trigger}>
              <div className="flex gap-0.5 rounded-lg bg-field p-0.5">
                {(
                  [
                    ["schedule", "Schedule", Clock01Icon],
                    ["linear", "Linear", Tag01Icon],
                    ["webhook", "Webhook", WebhookIcon],
                  ] as const
                ).map(([value, text, icon]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={state.trigger === value}
                    data-routine-trigger={value}
                    disabled={editing && state.trigger !== value}
                    onClick={() => {
                      // Only a schedule can check back on a Chat; another trigger starts new Chats.
                      const runIn = value !== "schedule" && state.runIn === "chat" ? "worktree" : state.runIn;
                      update({ trigger: value, runIn });
                    }}
                    className={`flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-[6px] text-[13px] font-medium disabled:opacity-40 ${
                      state.trigger === value ? "border border-line-strong bg-surface text-ink" : "text-ink-2"
                    }`}
                  >
                    <HugeiconsIcon icon={icon} size={14} strokeWidth={1.8} color="currentColor" />
                    {text}
                  </button>
                ))}
              </div>
            </Field>

            {state.trigger === "schedule" && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Field label="Runs" className="flex-1">
                    <Select<RoutineFormState["schedule"]["mode"]>
                      label="Runs"
                      value={state.schedule.mode}
                      options={[
                        { value: "every", label: "Every few minutes or hours" },
                        { value: "at", label: "At a time on chosen days" },
                        { value: "cron", label: "Advanced: cron" },
                      ]}
                      onChange={(mode) => update({ schedule: { ...state.schedule, mode } })}
                      triggerClassName="w-full"
                      width={260}
                    />
                  </Field>
                  <Field label="Timezone" error={errors.timezone} className="flex-1">
                    <Select
                      label="Timezone"
                      value={state.schedule.timezone}
                      options={timezones(state.schedule.timezone).map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }))}
                      onChange={(timezone) => update({ schedule: { ...state.schedule, timezone } })}
                      triggerClassName="w-full"
                      width={260}
                    />
                  </Field>
                </div>
                {state.schedule.mode === "every" && (
                  <Field label="Every" error={errors.schedule}>
                    <Select
                      label="Every"
                      value={`${state.schedule.every}${state.schedule.unit}`}
                      options={intervalOptions}
                      onChange={(value) => {
                        const match = /^(\d+)(min|h)$/.exec(value);
                        if (match) update({ schedule: { ...state.schedule, every: Number(match[1]), unit: match[2] as "min" | "h" } });
                      }}
                      triggerClassName="w-[168px]"
                      width={200}
                    />
                  </Field>
                )}
                {state.schedule.mode === "at" && (
                  <Field label="At" error={errors.schedule}>
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        aria-label="Time"
                        className={`${field} h-8 w-[120px] border-line-strong py-0`}
                        value={state.schedule.time}
                        onChange={(event) => update({ schedule: { ...state.schedule, time: event.target.value } })}
                      />
                      <div className="flex gap-1">
                        {DAYS.map((day, index) => {
                          const on = state.schedule.days.includes(index);
                          return (
                            <button
                              key={DAY_NAMES[index]}
                              type="button"
                              aria-label={DAY_NAMES[index]}
                              aria-pressed={on}
                              onClick={() =>
                                update({
                                  schedule: {
                                    ...state.schedule,
                                    days: on ? state.schedule.days.filter((entry) => entry !== index) : [...state.schedule.days, index],
                                  },
                                })
                              }
                              className={`size-8 rounded-lg text-[12px] font-medium transition-colors ${on ? "bg-ink text-surface" : "border border-line-strong bg-surface text-ink-2 hover:bg-hover"}`}
                            >
                              {day}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </Field>
                )}
                {state.schedule.mode === "cron" && (
                  <Field label="Cron" error={errors.schedule}>
                    <input
                      aria-label="Cron"
                      className={`${field} font-mono ${errors.schedule ? "border-red" : "border-line-strong"}`}
                      placeholder="30 8 * * 1-5"
                      value={state.schedule.cron}
                      onChange={(event) => update({ schedule: { ...state.schedule, cron: event.target.value } })}
                    />
                  </Field>
                )}
              </div>
            )}

            {state.trigger === "linear" && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Field label="When" className="flex-1">
                    <Select
                      label="When"
                      value={state.linear.event}
                      options={linearWhen}
                      onChange={(event) => update({ linear: { ...state.linear, event } })}
                      triggerClassName="w-full"
                      width={200}
                    />
                  </Field>
                  {state.linear.event === "label-added" && (
                    <Field label="Label" error={errors.label} className="flex-1">
                      {listOrInput("label")}
                    </Field>
                  )}
                  {state.linear.event === "state" && (
                    <Field label="State" error={errors.state} className="flex-1">
                      {listOrInput("state")}
                    </Field>
                  )}
                  <Field label="Team" className="flex-1">
                    <Select
                      label="Team"
                      value={state.linear.team}
                      options={[
                        { value: "", label: "Any team" },
                        ...(state.linear.team && !linear?.teams.some((entry) => entry.key === state.linear.team)
                          ? [{ value: state.linear.team, label: state.linear.team }]
                          : []),
                        ...(linear?.teams ?? []).map((entry) => ({ value: entry.key, label: `${entry.key} · ${entry.name}` })),
                      ]}
                      onChange={(next) => update({ linear: { ...state.linear, team: next, label: "", state: "" } })}
                      triggerClassName="w-full"
                      width={240}
                    />
                  </Field>
                </div>
                {(linear?.workspaces.length ?? 0) > 1 && (
                  <Field label="Workspace" error={errors.workspace}>
                    <Select
                      label="Workspace"
                      value={state.linear.workspace}
                      options={(linear?.workspaces ?? []).map((entry) => ({ value: entry.id, label: entry.name }))}
                      onChange={(next) => update({ linear: { ...state.linear, workspace: next, team: "", label: "", state: "" } })}
                      triggerClassName="w-[168px]"
                    />
                  </Field>
                )}
                {(errors.workspace && (linear?.workspaces.length ?? 0) <= 1) || linear?.error ? (
                  <p role="alert" data-routine-error className="text-[12px] text-red">
                    {linear?.error ?? errors.workspace}
                  </p>
                ) : null}
              </div>
            )}

            {state.trigger === "webhook" && (
              <div className="space-y-2">
                <Field label="URL">{urlCard(hookUrl)}</Field>
                <div className="flex gap-2">
                  <Field label="Signature header (optional)" className="flex-1">
                    <input
                      aria-label="Signature header"
                      className={`${field} border-line-strong`}
                      placeholder={DEFAULT_SIGNATURE_HEADER}
                      value={state.webhook.signingHeader}
                      onChange={(event) => update({ webhook: { ...state.webhook, signingHeader: event.target.value } })}
                    />
                  </Field>
                  <Field label="Signing secret (optional)" error={errors.signingSecret} className="flex-1">
                    <input
                      type="password"
                      aria-label="Signing secret"
                      autoComplete="off"
                      className={`${field} ${errors.signingSecret ? "border-red" : "border-line-strong"}`}
                      placeholder={state.webhook.signed ? "Kept; type to replace" : "HMAC SHA-256 secret"}
                      value={state.webhook.signingSecret}
                      onChange={(event) => update({ webhook: { ...state.webhook, signingSecret: event.target.value } })}
                    />
                  </Field>
                </div>
                {editing && state.webhook.signed && (
                  <label className="flex items-center gap-2 text-[12px] text-ink-2">
                    <input
                      type="checkbox"
                      checked={state.webhook.signed}
                      onChange={(event) => update({ webhook: { ...state.webhook, signed: event.target.checked, signingSecret: "" } })}
                    />
                    Check the signature
                  </label>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <Field label="Project" error={errors.project} className="flex-1">
                <Select
                  label="Project"
                  value={state.projectPath}
                  options={projectOptions.length ? projectOptions : [{ value: "", label: targets ? "No Projects" : "Loading…", disabled: true }]}
                  onChange={(projectPath) => update({ projectPath, chatId: "" })}
                  triggerClassName="w-full"
                  width={240}
                />
              </Field>
              <Field label="Each run" error={errors.runIn} className="flex-1">
                <Select<RoutineFormState["runIn"]>
                  label="Each run"
                  value={state.runIn}
                  options={runInOptions}
                  onChange={(runIn) => {
                    setErrors({});
                    setState((current) => withRunIn(current, runIn));
                  }}
                  triggerClassName="w-full"
                  width={260}
                />
              </Field>
              {heartbeat && (
                <Field label="Chat" error={errors.chat} className="flex-1">
                  <Select
                    label="Chat"
                    value={state.chatId}
                    options={chatOptions.length ? chatOptions : [{ value: "", label: "No Chats", disabled: true }]}
                    onChange={(chatId) => update({ chatId })}
                    triggerClassName="w-full"
                    width={260}
                  />
                </Field>
              )}
            </div>
            <div className="flex gap-2">
              <Field label="Model" className="flex-1">
                <Select
                  label="Model"
                  value={state.model}
                  options={modelOptions}
                  onChange={(model) => update({ model, provider: models.find((entry) => entry.id === model)?.provider ?? "" })}
                  triggerClassName="w-full"
                  width={260}
                />
              </Field>
              <Field label="Mode" className="flex-1">
                <Select
                  label="Mode"
                  value={state.permissionMode}
                  options={modeOptions}
                  onChange={(permissionMode) => update({ permissionMode })}
                  triggerClassName="w-full"
                  width={320}
                />
              </Field>
            </div>
            <Field label="Prompt" error={errors.prompt}>
              <PlaceholderTextarea
                label="Prompt"
                value={state.prompt}
                onChange={(prompt) => update({ prompt })}
                placeholders={placeholders}
                invalid={Boolean(errors.prompt)}
              />
              <p className="text-[12px] text-ink-2">{HINTS[state.trigger]}</p>
            </Field>
            <Field label="Stop after" error={errors.stop}>
              <div className="flex items-center gap-2">
                <Select<RoutineFormState["stop"]["kind"]>
                  label="Stop after"
                  value={state.stop.kind}
                  options={stopOptions}
                  onChange={(kind) => update({ stop: { ...state.stop, kind } })}
                  triggerClassName="w-[168px]"
                  width={220}
                />
                {state.stop.kind === "runs" && (
                  <input
                    type="number"
                    aria-label="Runs"
                    min={1}
                    max={1000}
                    className={`${field} h-8 w-[90px] border-line-strong py-0`}
                    value={state.stop.runs}
                    onChange={(event) => update({ stop: { ...state.stop, runs: Number(event.target.value) } })}
                  />
                )}
                {state.stop.kind === "date" && (
                  <input
                    type="date"
                    aria-label="Stop date"
                    className={`${field} h-8 w-[160px] border-line-strong py-0`}
                    min={dateValue(openedAt + DAY_MS)}
                    max={dateValue(openedAt + 30 * DAY_MS)}
                    value={dateValue(state.stop.at)}
                    onChange={(event) => {
                      const at = dateAt(event.target.value);
                      if (at !== null) update({ stop: { ...state.stop, at } });
                    }}
                  />
                )}
              </div>
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className={`${footerButton} border border-line bg-surface font-medium text-ink hover:bg-hover`} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" data-routine-save className={`${footerButton} bg-ink font-medium text-surface hover:opacity-90`} disabled={busy}>
                {busy ? "Saving…" : editing ? "Save" : "Create routine"}
              </button>
            </div>
          </form>
        )}
      </ScrollArea>
    </dialog>,
    document.body,
  );
}
