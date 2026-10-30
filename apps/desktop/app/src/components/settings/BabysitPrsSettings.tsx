import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  File01Icon,
  Message01Icon,
  Tick02Icon,
  Upload01Icon,
  UserCheck01Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import {
  BABYSIT_DEFAULTS,
  BABYSIT_LEVELS,
  DAYS_OPTIONS,
  FAILURE_OPTIONS,
  INTERVAL_OPTIONS,
  type BabysitLevel,
  type BabysitSettings,
  type BabysitStep,
  type BabysitWake,
} from "@milagre/shared/babysit";
import { createDebouncedSave, useBabysitSettings, type BabysitChange, type SaveState } from "../../lib/babysit-settings";
import { Checkbox } from "../primitives/Checkbox";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioGroup";
import { Select } from "../primitives/Select";
import { SettingCheckbox } from "../primitives/Checkbox";
import { Group, Row } from "./SettingsGroup";

type IconData = Parameters<typeof HugeiconsIcon>[0]["icon"];
type Save = (change: BabysitChange) => Promise<void>;

function Icon({ icon, size = 14 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

const WAKE: Array<{ kind: BabysitWake; label: string }> = [
  { kind: "comments", label: "Review comments" },
  { kind: "checks", label: "Failed checks" },
  { kind: "conflicts", label: "Merge conflicts" },
  { kind: "behind", label: "Branch behind base" },
];

const STEPS: Record<BabysitStep, { icon: IconData; name: string }> = {
  report: { icon: File01Icon, name: "Report" },
  fix: { icon: Wrench01Icon, name: "Fix" },
  push: { icon: Upload01Icon, name: "Push" },
  reply: { icon: Message01Icon, name: "Reply" },
  rerequest: { icon: UserCheck01Icon, name: "Re-request review" },
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const options = (values: readonly number[], one: string, many: string) => values.map((value) => ({ value: String(value), label: plural(value, one, many) }));

/** The Experimental › Babysit PRs row: whether babysitting is on, and the way into its page. */
export function BabysitPrsRow({ onOpen }: { onOpen: () => void }) {
  const { settings } = useBabysitSettings();
  return (
    <button
      type="button"
      data-babysit-prs-row
      onClick={onOpen}
      className="flex min-h-12 w-full items-center justify-between gap-6 px-4 py-2 text-left transition-colors hover:bg-hover"
    >
      <span className="grid min-w-0 gap-0.5">
        <span className="text-[13.5px] font-medium text-ink">Babysit PRs</span>
        <span className="text-[12px] text-ink-3">Watch every PR a Chat opens and fix review comments, failed checks and conflicts.</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[13px] text-ink-2">
        {settings && (settings.enabled ? "On" : "Off")}
        <span className="text-ink-3">
          <Icon icon={ArrowRight01Icon} size={16} />
        </span>
      </span>
    </button>
  );
}

/**
 * A typed field that saves itself shortly after typing stops and when it loses focus or the page closes. `reset` (Reset
 * all to defaults) drops what was typed, leaves the field and shows the default.
 */
function useAutosave(saved: string, key: "instructions" | "ownRuleText", save: Save, input: RefObject<HTMLElement | null>) {
  const [value, setValue] = useState(saved);
  // Text the host already holds counts as saved until it is edited.
  const [state, setState] = useState<SaveState>(saved ? "saved" : "idle");
  const focused = useRef(false);
  // Typed but not yet saved: a value from the host does not replace it (a failed save keeps the text).
  const dirty = useRef(false);
  // `save` is stable for the page's life, so one saver serves the field.
  const [saver] = useState(() => createDebouncedSave(save, 500, setState));
  useEffect(() => {
    if (state === "saved") dirty.current = false;
  }, [state]);
  useEffect(() => {
    if (focused.current || dirty.current) return;
    setValue(saved);
    setState((current) => (current === "saving" ? current : saved ? "saved" : "idle"));
  }, [saved]);
  // Leaving the page saves what was typed last.
  useEffect(() => () => void saver.flush(), [saver]);
  return {
    value,
    state,
    reset: () => {
      saver.cancel();
      dirty.current = false;
      focused.current = false;
      setValue(BABYSIT_DEFAULTS[key]);
      setState("idle");
      input.current?.blur();
    },
    onChange: (next: string) => {
      setValue(next);
      // Typing takes the Saved mark away until this text has saved.
      setState("idle");
      dirty.current = true;
      saver.edit({ [key]: next });
    },
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      void saver.flush();
    },
  };
}

function StepPill({ steps, selected }: { steps: readonly BabysitStep[]; selected: boolean }) {
  return (
    <span
      title={steps.map((step) => STEPS[step].name).join(" → ")}
      className={`flex h-6 shrink-0 items-center gap-0.5 rounded-full px-1.5 ${selected ? "bg-surface text-accent shadow-card" : "bg-field text-ink-2"}`}
    >
      {steps.map((step, index) => (
        <span key={step} data-step={step} className="flex items-center gap-0.5">
          {index > 0 && (
            <span className="text-ink-3">
              <Icon icon={ArrowRight01Icon} size={10} />
            </span>
          )}
          <Icon icon={STEPS[step].icon} size={13} />
        </span>
      ))}
    </span>
  );
}

/** A stop rule: its checkbox first, then what it says, then its number or note. */
function StopRow({
  id,
  label,
  description,
  checked,
  disabled = false,
  onChange,
  trailing,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-2.5 px-4 py-3">
      <div className="flex min-h-6 items-center gap-3">
        <Checkbox id={id} tone="accent" checked={checked} disabled={disabled} onCheckedChange={(next) => onChange?.(next === true)} />
        <label htmlFor={id} className={`grid min-w-0 flex-1 gap-0.5 ${disabled ? "" : "cursor-pointer"}`}>
          <span className="text-[13.5px] font-medium text-ink">{label}</span>
          {description && <span className="text-[12px] text-ink-3">{description}</span>}
        </label>
        {trailing && <span className="shrink-0 text-[12.5px] text-ink-3">{trailing}</span>}
      </div>
      {children}
    </div>
  );
}

function SaveMark({ state }: { state: SaveState }) {
  if (state === "error")
    return (
      <span role="alert" className="text-[12px] text-red-ink">
        Not saved
      </span>
    );
  if (state === "saving") return <span className="text-[12px] text-ink-3">Saving…</span>;
  if (state === "idle") return null;
  return (
    <span data-saved className="flex items-center gap-1 text-[12px] text-ink-3">
      <Icon icon={Tick02Icon} size={12} />
      Saved
    </span>
  );
}

function BabysitForm({ settings, save }: { settings: BabysitSettings; save: Save }) {
  // Switches, menus and checkboxes save at once; a failure shows in the page's error line.
  // Values that build on the current ones (chips, number rules) are worked out from the latest settings, changes still on their way included.
  const change = (patch: BabysitChange) => void save(patch).catch(() => {});
  const ownRuleInput = useRef<HTMLInputElement>(null);
  const instructionsInput = useRef<HTMLTextAreaElement>(null);
  const ownRule = useAutosave(settings.ownRuleText, "ownRuleText", save, ownRuleInput);
  const instructions = useAutosave(settings.instructions, "instructions", save, instructionsInput);
  const reset = () => {
    ownRule.reset();
    instructions.reset();
    change(BABYSIT_DEFAULTS);
  };
  const toggleWake = (kind: BabysitWake) =>
    change((current) => {
      const on = current.wake.includes(kind) ? current.wake.filter((item) => item !== kind) : [...current.wake, kind];
      return { wake: WAKE.map((item) => item.kind).filter((item) => on.includes(item)) };
    });
  return (
    <>
      <Group
        title="Babysit PRs"
        action={
          <button type="button" data-babysit-reset className="text-[12px] font-medium text-accent-ink hover:underline" onClick={reset}>
            Reset all to defaults
          </button>
        }
      >
        <Row
          label="Babysit new PRs"
          description="Off by default. When a Chat opens a PR, Milagre adds a Heartbeat to that Chat and watches the PR until it's done."
        >
          <SettingCheckbox label="Babysit new PRs" tone="accent" checked={settings.enabled} onChange={(enabled) => change({ enabled })} />
        </Row>
        <Row
          label="Check every"
          description="Milagre asks GitHub itself on this interval. The agent only wakes when something new shows up, so idle PRs cost nothing."
        >
          <Select
            label="Check every"
            width={140}
            value={String(settings.intervalMinutes)}
            options={options(INTERVAL_OPTIONS, "minute", "minutes")}
            onChange={(value) => change({ intervalMinutes: Number(value) })}
          />
        </Row>
        <div className="grid gap-2.5 px-4 py-3">
          <span id="babysit-wake" className="text-[13.5px] font-medium text-ink">
            Wake the agent for
          </span>
          <div role="group" aria-labelledby="babysit-wake" className="flex flex-wrap gap-1.5">
            {WAKE.map(({ kind, label }) => {
              const on = settings.wake.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleWake(kind)}
                  className={`flex h-7 items-center gap-1.5 rounded-full border px-2 text-[12.5px] font-medium transition-colors ${on ? "border-transparent bg-accent-tint text-accent-ink" : "border-line text-ink-2 hover:bg-hover"}`}
                >
                  <Icon icon={on ? Tick02Icon : Add01Icon} size={13} />
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </Group>
      <Group title="When something needs fixing" footer="Each PR keeps the settings it started with: changes here apply to PRs opened afterwards.">
        <RadioGroup
          aria-label="When something needs fixing"
          value={String(settings.level)}
          onValueChange={(value) => change({ level: Number(value) as BabysitLevel })}
          className="p-1.5"
        >
          {BABYSIT_LEVELS.map((entry) => {
            const selected = entry.level === settings.level;
            return (
              <label
                key={entry.level}
                data-babysit-level={entry.level}
                className={`flex cursor-pointer items-center gap-3 rounded-[10px] px-2.5 py-1.5 transition-colors ${selected ? "bg-accent-tint" : "hover:bg-hover"}`}
              >
                <RadioGroupItem tone="accent" value={String(entry.level)} />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className={`flex items-center gap-2 text-[13.5px] font-medium ${selected ? "text-accent-ink" : "text-ink"}`}>
                    {entry.title}
                    {entry.level === BABYSIT_DEFAULTS.level && (
                      <span className="rounded-[4px] bg-field px-1.5 py-px text-[11px] font-medium text-ink-2">Default</span>
                    )}
                  </span>
                  <span className={`text-[12px] ${selected ? "text-accent-ink" : "text-ink-3"}`}>{entry.description}</span>
                </span>
                <StepPill steps={entry.steps} selected={selected} />
              </label>
            );
          })}
        </RadioGroup>
        <Row label="Resolve threads it answered" description="On by default. After replying on a thread, the agent marks it resolved.">
          <SettingCheckbox
            label="Resolve threads it answered"
            tone="accent"
            checked={settings.resolveThreads}
            onChange={(resolveThreads) => change({ resolveThreads })}
          />
        </Row>
      </Group>
      <Group title="Stop babysitting when">
        <StopRow id="babysit-stop-closed" label="The PR is merged or closed" checked disabled trailing="Always" />
        <StopRow
          id="babysit-stop-green"
          label="Checks pass and the PR is approved"
          description="Nothing left to address. A comment that lands after this goes unwatched."
          checked={settings.stopWhenGreen}
          onChange={(stopWhenGreen) => change({ stopWhenGreen })}
        />
        <StopRow
          id="babysit-stop-days"
          label="It has watched the PR for"
          checked={settings.stopAfterDays.on}
          onChange={(on) => change((current) => ({ stopAfterDays: { ...current.stopAfterDays, on } }))}
          trailing={
            <Select
              label="Watch the PR for"
              width={120}
              disabled={!settings.stopAfterDays.on}
              triggerClassName="disabled:opacity-50"
              value={String(settings.stopAfterDays.days)}
              options={options(DAYS_OPTIONS, "day", "days")}
              onChange={(value) => change((current) => ({ stopAfterDays: { ...current.stopAfterDays, days: Number(value) } }))}
            />
          }
        />
        <StopRow
          id="babysit-stop-failures"
          label="It failed to fix the same problem"
          checked={settings.stopAfterFailures.on}
          onChange={(on) => change((current) => ({ stopAfterFailures: { ...current.stopAfterFailures, on } }))}
          trailing={
            <Select
              label="Failed to fix the same problem"
              width={120}
              disabled={!settings.stopAfterFailures.on}
              triggerClassName="disabled:opacity-50"
              value={String(settings.stopAfterFailures.times)}
              options={options(FAILURE_OPTIONS, "time", "times")}
              onChange={(value) => change((current) => ({ stopAfterFailures: { ...current.stopAfterFailures, times: Number(value) } }))}
            />
          }
        />
        <StopRow
          id="babysit-stop-own"
          label="Your own rule"
          description="The agent checks it each time it wakes and ends the Heartbeat when it holds."
          checked={settings.ownRule}
          onChange={(on) => change({ ownRule: on })}
        >
          {settings.ownRule && (
            <div className="grid gap-1">
              <input
                ref={ownRuleInput}
                aria-label="Your own rule"
                maxLength={300}
                value={ownRule.value}
                onChange={(event) => ownRule.onChange(event.target.value)}
                onFocus={ownRule.onFocus}
                onBlur={ownRule.onBlur}
                className="h-9 w-full rounded-[8px] bg-field px-3 text-[13px] text-ink outline-none placeholder:text-ink-3"
              />
              {ownRule.state === "error" && (
                <span role="alert" className="text-[12px] text-red-ink">
                  Not saved
                </span>
              )}
            </div>
          )}
        </StopRow>
      </Group>
      <Group title="Your instructions">
        <div className="grid gap-2 p-4">
          <textarea
            ref={instructionsInput}
            aria-label="Your instructions"
            rows={5}
            maxLength={4000}
            value={instructions.value}
            onChange={(event) => instructions.onChange(event.target.value)}
            onFocus={instructions.onFocus}
            onBlur={instructions.onBlur}
            className="w-full resize-y rounded-[8px] bg-field px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none"
          />
          <div className="flex min-h-4 justify-end">
            <SaveMark state={instructions.state} />
          </div>
        </div>
      </Group>
    </>
  );
}

/** Settings › Experimental › Babysit PRs: the one configuration every Chat's babysitting follows. */
export function BabysitPrsSettings({ onBack }: { onBack: () => void }) {
  const { settings, error, save } = useBabysitSettings();
  return (
    <div data-babysit-prs-page>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label="Back to Experimental"
          onClick={onBack}
          className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-field text-ink-2 transition-colors hover:bg-hover hover:text-ink"
        >
          <Icon icon={ArrowLeft01Icon} size={16} />
        </button>
        <h1 className="flex min-w-0 items-center gap-2 text-[22px] font-semibold tracking-[-0.01em] text-ink">
          <span className="text-ink-3">Experimental</span>
          <span className="text-ink-3">
            <Icon icon={ArrowRight01Icon} size={16} />
          </span>
          <span>Babysit PRs</span>
        </h1>
      </div>
      {error && (
        <p role="alert" className="mt-3 px-1 text-[12px] text-red-ink">
          {error}
        </p>
      )}
      {settings && <BabysitForm settings={settings} save={save} />}
    </div>
  );
}
