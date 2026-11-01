import { useEffect, useRef, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BubbleChatIcon,
  Clock01Icon,
  Copy01Icon,
  Delete02Icon,
  Folder01Icon,
  GitBranchIcon,
  RefreshIcon,
  SecurityCheckIcon,
  SparklesIcon,
  Tag01Icon,
  Tick02Icon,
  WebhookIcon,
} from "@hugeicons/core-free-icons";
import type { ModelCapabilities, ModelOption, Routine } from "@milagre/shared/model";
import { clock } from "@milagre/shared/routines";
import { ipcErrorMessage } from "@milagre/shared/result";
import { PROMPT_PLACEHOLDER, firstRunAt, promptHint, type RoutineFormState } from "@milagre/shared/routine-form";
import { Select } from "../primitives/Select";
import { ScrollArea } from "../primitives/ScrollArea";
import { PlaceholderTextarea } from "./PlaceholderTextarea";
import { Chip, PopoverChip, Segmented } from "./RoutineChips";
import { timezones, useRoutineForm, type RoutineFormApi } from "./use-routine-form";
import { routineIcon } from "./routine-icon";
import { routineDeleteWarning, type RoutineWithRuns } from "../../lib/routines";
import { bridgeForKey } from "../../lib/computer-bridge";

const field = "w-full rounded-lg border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-ink focus:ring-1 focus:ring-ink";
const labelClass = "block text-[12.5px] font-medium text-ink-2";
const smallButton =
  "inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-hover disabled:opacity-40";
const headerButton = "inline-flex h-[30px] shrink-0 items-center rounded-lg px-3 text-[13px] font-medium transition-colors disabled:opacity-40";
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 864e5;
const DEFAULT_SIGNATURE_HEADER = "sentry-hook-signature";

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

function FieldError({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <p role="alert" data-routine-error className="text-[12px] break-words text-red-ink">
      {text}
    </p>
  );
}

function Labeled({ label, error, children, className = "" }: { label: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 space-y-1.5 ${className}`}>
      <span className={labelClass}>{label}</span>
      {children}
      <FieldError text={error} />
    </div>
  );
}

/** The Schedule chip's popover: Every (number and unit), At a time (time, weekdays, timezone), or Cron (with its timezone). */
function SchedulePanel({ form }: { form: RoutineFormApi }) {
  const { state, update, errors } = form;
  const schedule = state.schedule;
  const set = (patch: Partial<RoutineFormState["schedule"]>) => update({ schedule: { ...schedule, ...patch } });
  const timezone = (
    <Labeled label="Timezone" error={errors.timezone}>
      <Select
        label="Timezone"
        value={schedule.timezone}
        options={timezones(schedule.timezone).map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }))}
        searchable
        onChange={(next) => set({ timezone: next })}
        triggerClassName="w-full"
        width={260}
      />
    </Labeled>
  );
  return (
    <>
      <Segmented<RoutineFormState["schedule"]["mode"]>
        label="Runs"
        value={schedule.mode}
        options={[
          { value: "every", label: "Every" },
          { value: "at", label: "At a time" },
          { value: "cron", label: "Cron" },
        ]}
        onChange={(mode) => set({ mode })}
      />
      {schedule.mode === "every" && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            {/* Only the steps a cron can repeat on evenly: minutes that divide an hour, hours that divide a day. */}
            <Select<string>
              label="Every"
              value={String(schedule.every)}
              options={(schedule.unit === "h" ? form.every.hours : form.every.minutes).map((value) => ({ value: String(value), label: String(value) }))}
              onChange={(every) => set({ every: Number(every) })}
              triggerClassName="w-[84px]"
              width={120}
            />
            <Select<"min" | "h">
              label="Unit"
              value={schedule.unit}
              options={[
                { value: "min", label: "minutes" },
                { value: "h", label: "hours" },
              ]}
              onChange={(unit) => {
                // A step the other unit doesn't offer becomes its nearest smaller one.
                const steps = (unit === "h" ? form.every.hours : form.every.minutes) as readonly number[];
                const every = steps.includes(schedule.every) ? schedule.every : (steps.findLast((step) => step <= schedule.every) ?? steps[0]!);
                set({ unit, every });
              }}
              triggerClassName="flex-1"
              width={160}
            />
          </div>
          <FieldError text={errors.schedule} />
        </div>
      )}
      {schedule.mode === "at" && (
        <>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input
                type="time"
                aria-label="Time"
                className={`${field} h-8 w-[104px] border-line-strong py-0`}
                value={schedule.time}
                onChange={(event) => set({ time: event.target.value })}
              />
              <div className="flex gap-1">
                {DAYS.map((day, index) => {
                  const on = schedule.days.includes(index);
                  return (
                    <button
                      key={DAY_NAMES[index]}
                      type="button"
                      aria-label={DAY_NAMES[index]}
                      aria-pressed={on}
                      onClick={() => set({ days: on ? schedule.days.filter((entry) => entry !== index) : [...schedule.days, index] })}
                      className={`size-7 rounded-lg text-[12px] font-medium transition-colors ${on ? "bg-ink text-surface" : "border border-line-strong bg-surface text-ink-2 hover:bg-hover"}`}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>
            <FieldError text={errors.schedule} />
          </div>
          {timezone}
        </>
      )}
      {schedule.mode === "cron" && (
        <>
          <div className="space-y-1.5">
            <input
              aria-label="Cron"
              className={`${field} font-mono ${errors.schedule ? "border-red" : "border-line-strong"}`}
              placeholder="30 8 * * 1-5"
              value={schedule.cron}
              onChange={(event) => set({ cron: event.target.value })}
            />
            <FieldError text={errors.schedule} />
          </div>
          {timezone}
        </>
      )}
    </>
  );
}

/** The Where chip's popover: the Project, where each Run works, and the Chat a Heartbeat checks back on. */
function WherePanel({ form }: { form: RoutineFormApi }) {
  const { state, update, errors, options, heartbeat, targets } = form;
  return (
    <>
      <Labeled label="Project" error={errors.project}>
        <Select
          label="Project"
          value={state.projectPath}
          options={options.project.length ? options.project : [{ value: "", label: targets ? "No Projects" : "Loading…", disabled: true }]}
          onChange={(projectPath) => update({ projectPath, chatId: "" })}
          triggerClassName="w-full"
          width={260}
        />
      </Labeled>
      <Labeled label="Each Run" error={errors.runIn}>
        <Select<RoutineFormState["runIn"]>
          label="Each Run"
          value={state.runIn}
          options={options.runIn}
          onChange={form.setRunIn}
          triggerClassName="w-full"
          width={280}
        />
      </Labeled>
      {heartbeat && (
        <Labeled label="Chat" error={errors.chat}>
          <Select
            label="Chat"
            value={state.chatId}
            options={options.chat.length ? options.chat : [{ value: "", label: "No Chats", disabled: true }]}
            onChange={(chatId) => update({ chatId })}
            triggerClassName="w-full"
            width={280}
          />
        </Labeled>
      )}
    </>
  );
}

/** A Linear trigger's rows under the chips: When, the label or state it watches, Team, and Workspace when there are several. */
function LinearRows({ form }: { form: RoutineFormApi }) {
  const { state, update, errors, linear, options } = form;
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
  return (
    <div data-routine-linear className="space-y-2">
      <div className="flex gap-2">
        <Labeled label="When" className="flex-1">
          <Select
            label="When"
            value={state.linear.event}
            options={options.linearWhen}
            onChange={(event) => update({ linear: { ...state.linear, event } })}
            triggerClassName="w-full"
            width={200}
          />
        </Labeled>
        {state.linear.event === "label-added" && (
          <Labeled label="Label" error={errors.label} className="flex-1">
            {listOrInput("label")}
          </Labeled>
        )}
        {state.linear.event === "state" && (
          <Labeled label="State" error={errors.state} className="flex-1">
            {listOrInput("state")}
          </Labeled>
        )}
        <Labeled label="Team" className="flex-1">
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
        </Labeled>
      </div>
      {(linear?.workspaces.length ?? 0) > 1 && (
        <Labeled label="Workspace" error={errors.workspace}>
          <Select
            label="Workspace"
            value={state.linear.workspace}
            options={(linear?.workspaces ?? []).map((entry) => ({ value: entry.id, label: entry.name }))}
            onChange={(next) => update({ linear: { ...state.linear, workspace: next, team: "", label: "", state: "" } })}
            triggerClassName="w-[168px]"
          />
        </Labeled>
      )}
      {(errors.workspace && (linear?.workspaces.length ?? 0) <= 1) || linear?.error ? <FieldError text={linear?.error ?? errors.workspace} /> : null}
    </div>
  );
}

/** A webhook's URL with Copy (and Rotate once it exists), or where it will appear. */
export function HookUrl({ url, form, editing }: { url: string | null; form?: RoutineFormApi; editing: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = (value: string) => {
    if (form) return form.copy(value);
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const shownCopied = form ? form.copied : copied;
  return (
    <div data-routine-hook className="space-y-2 rounded-[10px] border border-line bg-field px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={url ?? undefined}>
          {url ?? (!editing ? "The URL appears after you create the Routine." : "Reading the URL…")}
        </span>
        {url && (
          <button type="button" data-routine-hook-copy className={smallButton} onClick={() => copy(url)}>
            <HugeiconsIcon icon={shownCopied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={1.8} color="currentColor" />
            {shownCopied ? "Copied" : "Copy"}
          </button>
        )}
        {url && editing && form && !form.rotating && (
          <button type="button" data-routine-hook-rotate className={smallButton} onClick={() => form.setRotating(true)}>
            <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.8} color="currentColor" />
            Rotate
          </button>
        )}
      </div>
      {form?.rotating && (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[12px] text-ink">The old URL stops working at once.</span>
          <button type="button" className={smallButton} onClick={() => form.setRotating(false)}>
            Cancel
          </button>
          <button type="button" data-routine-hook-rotate-confirm className={`${smallButton} border-red/30 text-red-ink`} onClick={() => void form.rotate()}>
            Rotate
          </button>
        </div>
      )}
    </div>
  );
}

/** A webhook trigger's rows under the chips: its URL, the signature header and the signing secret. */
function WebhookRows({ form, initial }: { form: RoutineFormApi; initial?: RoutineWithRuns }) {
  const { state, update, errors, hook, editing } = form;
  return (
    <div data-routine-webhook className="space-y-2">
      <HookUrl url={hook?.url ?? null} form={form} editing={editing} />
      <div className="flex gap-2">
        <Labeled label="Signature header (optional)" className="flex-1">
          <input
            aria-label="Signature header"
            className={`${field} border-line-strong`}
            placeholder={DEFAULT_SIGNATURE_HEADER}
            value={state.webhook.signingHeader}
            onChange={(event) => update({ webhook: { ...state.webhook, signingHeader: event.target.value } })}
          />
        </Labeled>
        <Labeled label="Signing secret (optional)" error={errors.signingSecret} className="flex-1">
          <input
            type="password"
            aria-label="Signing secret"
            autoComplete="off"
            className={`${field} ${errors.signingSecret ? "border-red" : "border-line-strong"}`}
            placeholder={state.webhook.signed ? "Kept; type to replace" : "HMAC SHA-256 secret"}
            value={state.webhook.signingSecret}
            onChange={(event) => update({ webhook: { ...state.webhook, signingSecret: event.target.value } })}
          />
        </Labeled>
      </div>
      {initial?.trigger.kind === "webhook" && initial.trigger.signed && (
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
  );
}

/**
 * New Routine, or Edit with `initial`, in place of the Routine's page: the name as a field with Cancel and Save, how it
 * starts (new only), the settings as chips that open their pickers, Prompt, Stop after, and Delete Routine (edit only).
 * Escape cancels; the form consumes it, so the page behind stays.
 */
export function RoutineEditor({
  initial,
  models,
  capabilities = null,
  defaultProjectPath,
  onCancel,
  onSaved,
  onCreated,
  onDeleted,
  onDirtyChange,
  leaving = null,
  error,
}: {
  initial?: RoutineWithRuns;
  models: ModelOption[];
  capabilities?: ModelCapabilities | null;
  defaultProjectPath?: string;
  onCancel: () => void;
  onSaved: () => void;
  /** A new Routine was made; a webhook's comes with its URL. */
  onCreated: (routine: Routine, hookUrl?: string) => void;
  onDeleted: () => void;
  /** Whether the form has changes nobody saved, so whoever moves away from it asks first. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Somewhere else the window is going (another Routine, the list) while the form has changes: it asks to discard them. */
  leaving?: { onDiscard: () => void; onKeep: () => void } | null;
  /** A problem reading the Routines after a save, shown with the form's own. */
  error?: string | null;
}) {
  const form = useRoutineForm({ initial, models, capabilities, defaultProjectPath });
  const { state, update, errors, editing, comment } = form;
  const nameInput = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [now] = useState(() => Date.now());
  // Created: the page is on its way to the new Routine, and Create stays off so the same form never makes a second one.
  const [created, setCreated] = useState(false);
  // Cancel or Escape with changes asks to discard them first.
  const [asking, setAsking] = useState(false);
  const dirty = form.dirty && !created;

  useEffect(() => {
    nameInput.current?.focus();
  }, []);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyChange?.(false), []);

  const save = async () => {
    if (created) return;
    const saved = await form.submit();
    if (!saved) return;
    if (saved.kind === "created") {
      setCreated(true);
      onCreated(saved.routine, saved.hookUrl);
    } else onSaved();
  };
  const cancel = () => {
    if (dirty) setAsking(true);
    else onCancel();
  };
  const discard = leaving ?? (asking ? { onDiscard: onCancel, onKeep: () => setAsking(false) } : null);
  const remove = () => {
    if (!initial) return;
    setDeleteError("");
    bridgeForKey(initial.id)
      .deleteRoutine(initial.id)
      .then(onDeleted, (failure) => {
        setConfirming(false);
        setDeleteError(ipcErrorMessage(failure));
      });
  };
  const modelIcon = <HugeiconsIcon icon={SparklesIcon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0" />;
  const fallbackIcon = <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0" />;
  const modeIcon = <HugeiconsIcon icon={SecurityCheckIcon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0" />;
  const whereIcon = form.heartbeat ? BubbleChatIcon : state.runIn === "worktree" ? GitBranchIcon : Folder01Icon;
  const triggerIcon = initial ? routineIcon(initial) : state.trigger === "linear" ? Tag01Icon : state.trigger === "webhook" ? WebhookIcon : Clock01Icon;
  const first = firstRunAt(state, now);

  return (
    <ScrollArea className="flex h-full flex-col">
      <form
        data-routine-form
        data-routine-editor={initial?.id ?? "new"}
        aria-label={editing ? "Edit Routine" : "New Routine"}
        className="mx-auto flex w-full max-w-[680px] flex-1 flex-col px-6 pt-14 pb-10"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onKeyDown={(event) => {
          // Escape cancels and goes no further, so the Routines page (and App's Escape) stays put.
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          if (discard) discard.onKeep();
          else cancel();
        }}
      >
        <div className="flex items-center gap-3">
          <input
            ref={nameInput}
            aria-label="Name"
            placeholder="Name this Routine"
            className={`h-10 min-w-0 flex-1 rounded-lg border bg-surface px-3 text-[20px] font-semibold tracking-[-0.01em] text-ink outline-none placeholder:font-medium placeholder:text-ink-3 ${errors.name ? "border-red" : "border-accent"}`}
            value={state.name}
            onChange={(event) => update({ name: event.target.value })}
          />
          <button type="button" data-routine-cancel className={`${headerButton} border border-line-strong bg-surface text-ink hover:bg-hover`} onClick={cancel}>
            Cancel
          </button>
          <button
            type="submit"
            data-routine-save
            className={`${headerButton} bg-ink text-surface hover:opacity-90`}
            disabled={form.busy || created || (!editing && !form.ready)}
          >
            {form.busy ? "Saving…" : created ? "Created" : editing ? "Save" : "Create Routine"}
          </button>
        </div>
        <FieldError text={errors.name} />
        {discard && (
          <div
            role="alertdialog"
            aria-label="Discard changes"
            data-routine-discard
            className="mt-3 flex items-center gap-3 rounded-xl border border-line px-4 py-2.5"
          >
            <span className="min-w-0 flex-1 text-[12.5px] text-ink">Discard your changes to this Routine?</span>
            <button type="button" data-routine-discard-keep className={smallButton} onClick={discard.onKeep}>
              Keep editing
            </button>
            <button type="button" data-routine-discard-confirm className={`${smallButton} border-red/30 text-red-ink`} onClick={discard.onDiscard}>
              Discard
            </button>
          </div>
        )}
        {error && (
          <p role="alert" data-routine-top-error className="mt-3 text-[12.5px] break-words text-red-ink">
            {error}
          </p>
        )}
        {form.topError && (
          <p role="alert" data-routine-top-error className="mt-3 text-[12.5px] break-words text-red-ink">
            {form.topError}
          </p>
        )}

        {!editing && (
          <div className="mt-5 space-y-1.5">
            <span className={labelClass}>Starts</span>
            <Segmented<RoutineFormState["trigger"]>
              label="Starts"
              size="large"
              value={state.trigger}
              options={[
                { value: "schedule", label: "On a schedule", icon: Clock01Icon },
                { value: "linear", label: "Linear event", icon: Tag01Icon },
                { value: "webhook", label: "Webhook", icon: WebhookIcon },
              ]}
              onChange={form.setTrigger}
            />
            <FieldError text={errors.trigger} />
          </div>
        )}

        <div data-routine-chips className="mt-4 flex flex-wrap items-center gap-2">
          {state.trigger === "schedule" ? (
            <PopoverChip label="Schedule" icon={triggerIcon} text={form.triggerText} invalid={Boolean(errors.schedule || errors.timezone)} width={340}>
              <SchedulePanel form={form} />
            </PopoverChip>
          ) : (
            <Chip icon={triggerIcon} data-routine-chip="trigger">
              {form.triggerText}
            </Chip>
          )}
          {!comment && (
            <PopoverChip label="Where" icon={whereIcon} text={form.whereText} invalid={Boolean(errors.project || errors.runIn || errors.chat)} width={300}>
              <WherePanel form={form} />
            </PopoverChip>
          )}
          <Select
            label="Model"
            variant="chip"
            leading={modelIcon}
            value={state.model}
            options={form.options.model}
            onChange={(model) => update({ model, provider: models.find((entry) => entry.id === model)?.provider ?? "" })}
            width={260}
          />
          {form.fallback && (
            <Select
              label="Fallback"
              variant="chip"
              leading={fallbackIcon}
              value={form.fallbackValue}
              options={form.options.fallback}
              onChange={form.setFallback}
              width={300}
            />
          )}
          {form.fallback && state.fallbackModel && form.options.fallbackEffort && (
            <Select
              label="Fallback effort"
              variant="chip"
              leading={fallbackIcon}
              value={state.fallbackEffort}
              options={form.options.fallbackEffort}
              onChange={(fallbackEffort) => update({ fallbackEffort })}
              width={200}
            />
          )}
          <Select
            label="Mode"
            variant="chip"
            leading={modeIcon}
            value={state.permissionMode}
            options={form.options.mode}
            onChange={(permissionMode) => update({ permissionMode })}
            width={320}
          />
        </div>
        <div className="mt-1.5 space-y-1">
          <FieldError text={errors.schedule || errors.timezone} />
          <FieldError text={errors.project || errors.runIn || errors.chat} />
        </div>

        {(state.trigger === "linear" || state.trigger === "webhook") && (
          <div className="mt-3">{state.trigger === "linear" ? <LinearRows form={form} /> : <WebhookRows form={form} initial={initial} />}</div>
        )}
        {comment && (
          <p data-routine-comment-note className="mt-3 text-[12.5px] text-ink-2">
            Comments go into the Chat linked to the issue.
          </p>
        )}

        <div className="mt-6 space-y-1.5">
          <span className={labelClass}>Prompt</span>
          <PlaceholderTextarea
            label="Prompt"
            value={state.prompt}
            onChange={(prompt) => update({ prompt })}
            placeholders={form.placeholders}
            invalid={Boolean(errors.prompt)}
            placeholder={PROMPT_PLACEHOLDER}
            rows={5}
          />
          <p data-routine-prompt-hint className="text-[12px] text-ink-3">
            {promptHint(state.trigger)}
          </p>
          <FieldError text={errors.prompt} />
        </div>

        <div className="mt-5 space-y-1.5">
          <span className={labelClass}>Stop after</span>
          <div className="flex items-center gap-2">
            <Select<RoutineFormState["stop"]["kind"]>
              label="Stop after"
              value={state.stop.kind}
              options={form.options.stop}
              onChange={(kind) => update({ stop: { ...state.stop, kind } })}
              triggerClassName="w-[200px]"
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
                min={dateValue(form.openedAt + DAY_MS)}
                max={dateValue(form.openedAt + 30 * DAY_MS)}
                value={dateValue(state.stop.at)}
                onChange={(event) => {
                  const at = dateAt(event.target.value);
                  // The last day offered ends a little before the store's 30 day limit, not at 23:59.
                  if (at !== null) update({ stop: { ...state.stop, at: Math.min(at, form.openedAt + 30 * DAY_MS - 60_000) } });
                }}
              />
            )}
          </div>
          <FieldError text={errors.stop} />
        </div>

        {initial && (
          <div data-routine-delete className="mt-8 flex min-h-12 items-center gap-3 rounded-xl border border-line px-4 py-2.5">
            <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">
              {confirming ? `Delete ${initial.name}? ${routineDeleteWarning(initial)}` : routineDeleteWarning(initial)}
            </span>
            {confirming ? (
              <>
                <button type="button" className={smallButton} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button type="button" data-routine-delete-confirm className={`${smallButton} border-red/30 text-red-ink`} onClick={remove}>
                  Delete
                </button>
              </>
            ) : (
              <button
                type="button"
                data-routine-delete-start
                onClick={() => setConfirming(true)}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-red-ink transition-colors hover:bg-red-tint"
              >
                <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.8} color="currentColor" />
                Delete Routine
              </button>
            )}
          </div>
        )}
        <FieldError text={deleteError} />

        {!editing && (
          <section data-routine-runs-placeholder className="mt-8 space-y-1.5">
            <h2 className="text-[13px] font-semibold text-ink-3">Runs</h2>
            <p className="text-[12.5px] text-ink-3">
              Runs show here once the Routine is created.
              {state.trigger === "schedule" && first !== null ? ` The first one starts at ${clock(first)}.` : ""}
            </p>
          </section>
        )}
      </form>
    </ScrollArea>
  );
}
