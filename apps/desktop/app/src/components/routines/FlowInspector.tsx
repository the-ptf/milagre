import { useRef, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, Cancel01Icon, CodeIcon, PlusSignIcon, TestTube01Icon } from "@hugeicons/core-free-icons";
import type {
  FlowAgentStep,
  FlowAskStep,
  FlowCommentStep,
  FlowField,
  FlowIfStep,
  FlowPullRequestStep,
  FlowStep,
  FlowWaitStep,
  ModelCapabilities,
  ModelOption,
  PermissionMode,
  RoutineTrigger,
} from "@milagre/shared/model";
import { capabilityFor } from "@milagre/shared/model-options";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import { PROVIDERS, providerName } from "@milagre/shared/providers";
import { FLOW_LIMITS, fieldsBefore, stepReads, triggerFields, usedBy, type FlowReadable } from "@milagre/shared/routine-flows";
import { Select, type SelectOption } from "../primitives/Select";
import { Checkbox } from "../primitives/Checkbox";
import { ScrollArea } from "../primitives/ScrollArea";
import { ProviderLogo } from "../ProviderLogo";
import { PlaceholderTextarea } from "./PlaceholderTextarea";
import { FIELD_ICON, FIELD_TYPE_WORDS, triggerTitle } from "./flow-look";
import { Popover, usePopover } from "./FlowPopover";
import { FieldChip, StepTile } from "./FlowSteps";

const input =
  "h-8 w-full min-w-0 rounded-control border border-line-strong bg-surface px-2 text-13 text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const sectionLabel = "text-12 font-medium text-ink-2";
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/** What kind of step the inspector shows, under its name. */
const KIND_WORDS: Record<FlowStep["kind"], string> = {
  agent: "Agent step",
  if: "Condition",
  ask: "Approval",
  wait: "Wait",
  "pull-request": "Action",
  "linear-comment": "Action",
};

/** The inspector's card: the step's tile, name and what it is, a ⋯ beside it, then its settings. */
export function InspectorCard({
  kind,
  title,
  subtitle,
  menu,
  children,
  ...data
}: {
  kind: FlowStep["kind"] | "trigger";
  title: string;
  subtitle: string;
  menu?: ReactNode;
  children: ReactNode;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <section className="rounded-card bg-surface p-4 shadow-card" {...data}>
      <div className="flex items-start gap-3">
        <StepTile kind={kind} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h3 className="truncate text-15 font-semibold text-ink">{title}</h3>
          <p className="text-12 text-ink-3">{subtitle}</p>
        </div>
        {menu}
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

/** A setting's row: its name on the left, its control on the right. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line py-1 last:border-0">
      <span className="shrink-0 text-13 text-ink-2">{label}</span>
      <span className="flex min-w-0 flex-1 justify-end">{children}</span>
    </div>
  );
}

function Labeled({ label, trailing, children }: { label: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <span className={sectionLabel}>{label}</span>
        {trailing}
      </div>
      {children}
    </div>
  );
}

function NumberInput({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      value={Number.isFinite(value) ? value : ""}
      onChange={(event) => {
        const next = Math.round(Number(event.target.value));
        onChange(Number.isFinite(next) ? Math.max(min, Math.min(max, next)) : min);
      }}
      className={`${input} w-20 text-right tabular-nums`}
    />
  );
}

/** "Insert field": the fields a step can read, grouped by the step that gives them; a pick inserts `{{ref}}`. */
function InsertField({ fields, onInsert, label = "Insert field" }: { fields: FlowReadable[]; onInsert: (ref: string) => void; label?: string }) {
  const popover = usePopover(300, "end");
  return (
    <>
      <button
        ref={popover.trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={popover.open}
        data-flow-insert-field
        disabled={fields.length === 0}
        onClick={popover.toggle}
        className="inline-flex h-6 items-center gap-1 rounded-chip px-1.5 text-12 font-medium text-accent-ink transition-colors hover:bg-accent-tint disabled:opacity-40"
      >
        <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={1.6} color="currentColor" />
        {label}
      </button>
      <Popover state={popover} label="Insert field" width={300} role="menu" data-flow-insert-menu>
        <ScrollArea className="flex-1 p-1.5">
          {fields.map((field, index) => (
            <div key={field.ref}>
              {field.stepName !== fields[index - 1]?.stepName && <p className="px-2 pt-2 pb-1 text-11 font-medium text-ink-3">{field.stepName}</p>}
              <button
                type="button"
                role="menuitem"
                data-menu-row
                data-flow-field={field.ref}
                onClick={() => {
                  popover.close();
                  onInsert(field.ref);
                }}
                className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover-2"
              >
                <HugeiconsIcon icon={FIELD_ICON[field.type] ?? CodeIcon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate text-13 text-ink">{field.label}</span>
                <span className="shrink-0 font-mono text-11 text-ink-3">{field.ref}</span>
              </button>
            </div>
          ))}
        </ScrollArea>
      </Popover>
    </>
  );
}

/**
 * A step's text that can read fields: typing `{{` lists them (PlaceholderTextarea), and Insert field puts one where the
 * caret was.
 */
function FieldText({
  label,
  value,
  onChange,
  fields,
  rows = 4,
  placeholder,
  invalid = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  fields: FlowReadable[];
  rows?: number;
  placeholder?: string;
  invalid?: boolean;
}) {
  const caret = useRef<{ start: number; end: number } | null>(null);
  const remember = (target: EventTarget) => {
    if (target instanceof HTMLTextAreaElement) caret.current = { start: target.selectionStart, end: target.selectionEnd };
  };
  const insert = (ref: string) => {
    const at = caret.current ?? { start: value.length, end: value.length };
    onChange(`${value.slice(0, at.start)}{{${ref}}}${value.slice(at.end)}`);
    const end = at.start + ref.length + 4;
    caret.current = { start: end, end };
  };
  return (
    <Labeled label={label} trailing={<InsertField fields={fields} onInsert={insert} />}>
      <div
        data-flow-text={label}
        onKeyUp={(event) => remember(event.target)}
        onMouseUp={(event) => remember(event.target)}
        onInput={(event) => remember(event.target)}
        onSelect={(event) => remember(event.target)}
      >
        <PlaceholderTextarea
          label={label}
          value={value}
          onChange={onChange}
          placeholders={fields.map((field) => ({ name: field.ref, example: field.stepName }))}
          rows={rows}
          placeholder={placeholder}
          invalid={invalid}
        />
      </div>
    </Labeled>
  );
}

function NameField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Labeled label="Name">
      <input
        aria-label="Step name"
        data-flow-step-name
        className={input}
        value={value}
        maxLength={FLOW_LIMITS.name}
        onChange={(event) => onChange(event.target.value)}
      />
    </Labeled>
  );
}

/** Whether a field read in a text is still readable there: a chip in the step's Reads that no earlier step gives is red. */
function Reads({ refs, readable }: { refs: string[]; readable: ReadonlySet<string> }) {
  if (refs.length === 0) return null;
  return (
    <Labeled label="Reads">
      <div data-flow-reads className="flex flex-wrap gap-1.5">
        {refs.map((ref) => (
          <span
            key={ref}
            data-flow-read={ref}
            className={`inline-flex h-6 items-center rounded-chip px-2 text-12 ${readable.has(ref) ? "bg-purple-tint text-purple-ink" : "bg-red-tint text-red-ink"}`}
          >
            {ref.replace(/^trigger\./, "")}
          </span>
        ))}
      </div>
    </Labeled>
  );
}

const RETRY_OPTIONS: SelectOption<string>[] = Array.from({ length: FLOW_LIMITS.retries + 1 }, (_, n) => ({
  value: String(n),
  label: n === 0 ? "Stop at once" : `Retry ${n === 1 ? "once" : n === 2 ? "twice" : `${n} times`}, then stop`,
}));
const TYPE_OPTIONS: SelectOption<FlowField["type"]>[] = (["text", "choice", "yes-no", "number", "link"] as const).map((type) => ({
  value: type,
  label: FIELD_TYPE_WORDS[type],
}));

/** An agent step's Output table: each field's name, type (and choices), how many steps read it, and remove. */
function OutputFields({ step, steps, onChange }: { step: FlowAgentStep; steps: FlowStep[]; onChange: (output: FlowField[]) => void }) {
  const set = (index: number, patch: Partial<FlowField>) => onChange(step.output.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  const addField = () => {
    const taken = new Set(step.output.map((field) => field.name));
    let n = step.output.length + 1;
    while (taken.has(`field${n}`)) n += 1;
    onChange([...step.output, { name: `field${n}`, type: "text" }]);
  };
  return (
    <Labeled
      label="Output"
      trailing={
        step.output.length < FLOW_LIMITS.fields && (
          <button
            type="button"
            data-flow-add-field
            onClick={addField}
            className="inline-flex h-6 items-center gap-1 rounded-chip px-1.5 text-12 font-medium text-accent-ink transition-colors hover:bg-accent-tint"
          >
            <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={1.6} color="currentColor" />
            Add field
          </button>
        )
      }
    >
      {step.output.length === 0 ? (
        <p className="text-12 text-ink-3">No fields. Add one for later steps to read what this agent decides.</p>
      ) : (
        <div data-flow-output className="divide-y divide-line rounded-control border border-line">
          {step.output.map((field, index) => {
            const ref = `${step.id}.${field.name}`;
            const readers = usedBy(steps, ref);
            const badName = !FIELD_NAME.test(field.name);
            const choices = field.choices ?? [];
            const fewChoices = field.type === "choice" && choices.map((choice) => choice.trim()).filter(Boolean).length < 2;
            return (
              <div key={index} data-flow-output-field={field.name} className="space-y-1.5 px-2 py-2">
                <div className="flex items-center gap-2">
                  <HugeiconsIcon icon={FIELD_ICON[field.type] ?? CodeIcon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink-3" />
                  <input
                    aria-label="Field name"
                    className={`${input} h-7 flex-1 ${badName ? "border-red" : ""}`}
                    value={field.name}
                    onChange={(event) => set(index, { name: event.target.value })}
                  />
                  <Select<FlowField["type"]>
                    label="Field type"
                    variant="text"
                    value={field.type}
                    options={TYPE_OPTIONS}
                    onChange={(type) => set(index, type === "choice" ? { type, choices: field.choices ?? ["", ""] } : { type, choices: undefined })}
                    width={160}
                  />
                  <span className={`w-14 shrink-0 text-right text-11 ${readers ? "text-accent-ink" : "text-ink-3"}`}>
                    {readers ? `used by ${readers}` : "unused"}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${field.name}`}
                    onClick={() => onChange(step.output.filter((_, at) => at !== index))}
                    className="flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.6} color="currentColor" />
                  </button>
                </div>
                {field.type === "choice" && (
                  <input
                    aria-label={`Choices for ${field.name}`}
                    placeholder="small, medium, large"
                    className={`${input} h-7 ${fewChoices ? "border-red" : ""}`}
                    value={choices.join(", ")}
                    onChange={(event) => set(index, { choices: event.target.value.split(",").map((choice) => choice.trimStart()) })}
                  />
                )}
                {badName && <p className="text-11 text-red-ink">Letters, digits and _, starting with a letter</p>}
                {!badName && fewChoices && <p className="text-11 text-red-ink">Give at least two choices, separated by commas</p>}
              </div>
            );
          })}
        </div>
      )}
    </Labeled>
  );
}

function AgentFields({
  step,
  steps,
  fields,
  models,
  capabilities,
  set,
}: {
  step: FlowAgentStep;
  steps: FlowStep[];
  fields: FlowReadable[];
  models: ModelOption[];
  capabilities: ModelCapabilities | null;
  set: (patch: Partial<FlowAgentStep>) => void;
}) {
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: "The flow's model" },
    ...PROVIDERS.flatMap((provider) =>
      models
        .filter((model) => model.provider === provider)
        .map((model) => ({
          value: `${provider}:${model.id}`,
          label: model.name,
          icon: <ProviderLogo provider={provider} size={14} />,
          group: providerName(provider),
        })),
    ),
  ];
  const modelValue = step.model ? `${step.provider ?? ""}:${step.model}` : "";
  if (step.model && !modelOptions.some((option) => option.value === modelValue)) modelOptions.push({ value: modelValue, label: step.model });
  const picked = step.model ? models.find((model) => model.id === step.model && (!step.provider || model.provider === step.provider)) : undefined;
  const efforts = picked ? capabilityFor(picked, capabilities).efforts : [];
  const effortOptions: SelectOption<string>[] = [
    { value: "", label: "Default effort" },
    ...efforts.map((effort) => ({ value: effort, label: `${effort[0]!.toUpperCase()}${effort.slice(1)} effort` })),
  ];
  if (step.effort && !efforts.includes(step.effort)) effortOptions.push({ value: step.effort, label: `${step.effort} effort` });
  const modeOptions: SelectOption<string>[] = [
    { value: "", label: "The flow's mode" },
    ...PERMISSION_MODES.map((mode) => ({ value: mode.id, label: mode.name, description: mode.description })),
  ];
  const readable = new Set(fields.map((field) => field.ref));
  return (
    <>
      <NameField value={step.name} onChange={(name) => set({ name })} />
      <FieldText
        label="Prompt"
        value={step.prompt}
        onChange={(prompt) => set({ prompt })}
        fields={fields}
        rows={5}
        placeholder="What should the agent do?"
        invalid={!step.prompt.trim()}
      />
      <Reads refs={stepReads(step)} readable={readable} />
      <div>
        <Row label="Model">
          <Select
            label="Model"
            variant="text"
            value={modelValue}
            options={modelOptions}
            onChange={(value) => {
              const split = value.indexOf(":");
              if (split < 0) return set({ provider: undefined, model: undefined, effort: undefined });
              const provider = value.slice(0, split) as FlowAgentStep["provider"];
              const model = value.slice(split + 1);
              const next = models.find((entry) => entry.provider === provider && entry.id === model);
              const nextEfforts = next ? capabilityFor(next, capabilities).efforts : [];
              set({ provider, model, effort: step.effort && nextEfforts.includes(step.effort) ? step.effort : undefined });
            }}
            width={280}
          />
        </Row>
        {(efforts.length > 0 || step.effort) && (
          <Row label="Effort">
            <Select
              label="Effort"
              variant="text"
              value={step.effort ?? ""}
              options={effortOptions}
              onChange={(effort) => set({ effort: effort || undefined })}
              width={200}
            />
          </Row>
        )}
        <Row label="Permissions">
          <Select
            label="Permissions"
            variant="text"
            value={step.permissionMode ?? ""}
            options={modeOptions}
            onChange={(mode) => set({ permissionMode: (mode || undefined) as PermissionMode | undefined })}
            width={300}
          />
        </Row>
        <Row label="Chat">
          <Select<FlowAgentStep["chat"]>
            label="Chat"
            variant="text"
            value={step.chat}
            options={[
              { value: "run", label: "Run Chat", description: "The Chat the Run's first agent step made" },
              { value: "own", label: "Its own Chat", description: "A new Chat in the same Worktree" },
            ]}
            onChange={(chat) => set({ chat })}
            width={280}
          />
        </Row>
        <Row label="If it fails">
          <Select
            label="If it fails"
            variant="text"
            value={String(step.retries)}
            options={RETRY_OPTIONS}
            onChange={(retries) => set({ retries: Number(retries) })}
            width={220}
          />
        </Row>
      </div>
      <OutputFields step={step} steps={steps} onChange={(output) => set({ output })} />
      <Row label="If output is invalid">
        <Select<FlowAgentStep["onInvalid"]>
          label="If output is invalid"
          variant="text"
          value={step.onInvalid}
          options={[
            { value: "ask-once", label: "Ask the agent once, then stop" },
            { value: "stop", label: "Stop" },
          ]}
          onChange={(onInvalid) => set({ onInvalid })}
          width={260}
        />
      </Row>
    </>
  );
}

function IfFields({ step, fields, set }: { step: FlowIfStep; fields: FlowReadable[]; set: (patch: Partial<FlowIfStep>) => void }) {
  const fieldOptions: SelectOption<string>[] = fields.map((field) => ({ value: field.ref, label: field.label, group: field.stepName }));
  if (step.field && !fields.some((field) => field.ref === step.field)) fieldOptions.unshift({ value: step.field, label: `${step.field} (not readable here)` });
  if (!step.field) fieldOptions.unshift({ value: "", label: "Choose a field", disabled: true });
  const field = fields.find((entry) => entry.ref === step.field);
  const valueChoices: SelectOption<string>[] | null =
    field?.type === "choice" && field.choices?.length
      ? field.choices.map((choice) => ({ value: choice, label: choice }))
      : field?.type === "yes-no"
        ? [
            { value: "true", label: "yes" },
            { value: "false", label: "no" },
          ]
        : null;
  if (valueChoices && step.value && !valueChoices.some((option) => option.value === step.value)) valueChoices.unshift({ value: step.value, label: step.value });
  if (valueChoices && !step.value) valueChoices.unshift({ value: "", label: "Choose a value", disabled: true });
  return (
    <>
      <NameField value={step.name} onChange={(name) => set({ name })} />
      <div>
        <Row label="Field">
          <Select
            label="Field"
            variant="text"
            value={step.field}
            options={fieldOptions}
            onChange={(next) => set({ field: next, value: "" })}
            width={280}
            searchable={fields.length > 8}
          />
        </Row>
        <Row label="Test">
          <Select<FlowIfStep["test"]>
            label="Test"
            variant="text"
            value={step.test}
            options={[
              { value: "is", label: "is" },
              { value: "is-not", label: "is not" },
              { value: "contains", label: "contains" },
              { value: "is-set", label: "is set" },
            ]}
            onChange={(test) => set({ test })}
            width={160}
          />
        </Row>
        {step.test !== "is-set" && (
          <Row label="Value">
            {valueChoices && step.test !== "contains" ? (
              <Select label="Value" variant="text" value={step.value ?? ""} options={valueChoices} onChange={(value) => set({ value })} width={200} />
            ) : (
              <input aria-label="Value" className={`${input} w-48`} value={step.value ?? ""} onChange={(event) => set({ value: event.target.value })} />
            )}
          </Row>
        )}
      </div>
      <p className="text-12 text-ink-3">
        Steps under Yes run when the test holds; steps under Otherwise run when it doesn't. Then the flow goes on after the If.
      </p>
    </>
  );
}

function AskFields({ step, fields, set }: { step: FlowAskStep; fields: FlowReadable[]; set: (patch: Partial<FlowAskStep>) => void }) {
  return (
    <>
      <NameField value={step.name} onChange={(name) => set({ name })} />
      <FieldText
        label="Message"
        value={step.message}
        onChange={(message) => set({ message })}
        fields={fields}
        rows={4}
        placeholder="What should you check before the flow goes on?"
      />
      <Row label="Hours to answer">
        <NumberInput
          label="Hours to answer"
          value={step.expiresInHours}
          min={1}
          max={FLOW_LIMITS.askHours}
          onChange={(expiresInHours) => set({ expiresInHours })}
        />
      </Row>
      <p className="text-12 text-ink-3">You can answer on any device. Rejecting it, or no answer in time, ends the Run.</p>
    </>
  );
}

function WaitFields({ step, set }: { step: FlowWaitStep; set: (patch: Partial<FlowWaitStep>) => void }) {
  const { until } = step;
  return (
    <>
      <NameField value={step.name} onChange={(name) => set({ name })} />
      <div>
        <Row label="Until">
          <Select<FlowWaitStep["until"]["kind"]>
            label="Until"
            variant="text"
            value={until.kind}
            options={[
              { value: "time", label: "Some time passes" },
              { value: "linear-state", label: "The issue reaches a state" },
              { value: "pr-review", label: "The pull request is reviewed" },
            ]}
            onChange={(kind) => set({ until: kind === "time" ? { kind, minutes: 60 } : kind === "linear-state" ? { kind, state: "" } : { kind: "pr-review" } })}
            width={260}
          />
        </Row>
        {until.kind === "time" && (
          <Row label="Minutes">
            <NumberInput
              label="Minutes"
              value={until.minutes}
              min={1}
              max={FLOW_LIMITS.waitMinutes}
              onChange={(minutes) => set({ until: { kind: "time", minutes } })}
            />
          </Row>
        )}
        {until.kind === "linear-state" && (
          <Row label="State">
            <input
              aria-label="State"
              placeholder="In Review"
              className={`${input} w-48`}
              value={until.state}
              onChange={(event) => set({ until: { kind: "linear-state", state: event.target.value } })}
            />
          </Row>
        )}
        {until.kind !== "time" && (
          <Row label="Time limit, hours">
            <NumberInput
              label="Time limit in hours"
              value={step.timeoutHours}
              min={1}
              max={FLOW_LIMITS.timeoutHours}
              onChange={(timeoutHours) => set({ timeoutHours })}
            />
          </Row>
        )}
      </div>
      {until.kind !== "time" && <p className="text-12 text-ink-3">The step fails when the time limit passes first.</p>}
    </>
  );
}

function PullRequestFields({ step, fields, set }: { step: FlowPullRequestStep; fields: FlowReadable[]; set: (patch: Partial<FlowPullRequestStep>) => void }) {
  return (
    <>
      <NameField value={step.name} onChange={(name) => set({ name })} />
      <FieldText label="Title" value={step.title} onChange={(title) => set({ title })} fields={fields} rows={2} invalid={!step.title.trim()} />
      <FieldText label="Description" value={step.body} onChange={(body) => set({ body })} fields={fields} rows={5} placeholder="What the pull request does" />
      <Row label="Base branch">
        <input
          aria-label="Base branch"
          placeholder="The repository's default"
          className={`${input} w-48`}
          value={step.base ?? ""}
          onChange={(event) => set({ base: event.target.value || undefined })}
        />
      </Row>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-13 text-ink">
          <Checkbox data-flow-draft checked={step.draft} onCheckedChange={(value) => set({ draft: value === true })} />
          Open as draft
        </label>
        <label className="flex items-center gap-2 text-13 text-ink">
          <Checkbox data-flow-ask-first checked={step.askFirst} onCheckedChange={(value) => set({ askFirst: value === true })} />
          Ask me first
        </label>
      </div>
      <p className="text-12 text-ink-3">
        Pushes the Run's branch and opens the pull request once. It keeps a receipt, so a restart or a retry never opens a second one.
      </p>
    </>
  );
}

function CommentFields({ step, fields, set }: { step: FlowCommentStep; fields: FlowReadable[]; set: (patch: Partial<FlowCommentStep>) => void }) {
  return (
    <>
      <NameField value={step.name} onChange={(name) => set({ name })} />
      <FieldText
        label="Comment"
        value={step.body}
        onChange={(body) => set({ body })}
        fields={fields}
        rows={5}
        placeholder="What to post on the issue"
        invalid={!step.body.trim()}
      />
      <p className="text-12 text-ink-3">Posts to the Run's Linear issue once per Run.</p>
    </>
  );
}

/**
 * The selected step's settings, by type, with its problems on top. Every change goes through `onChange` with the whole
 * step.
 */
export function StepInspector({
  step,
  steps,
  trigger,
  status,
  problems,
  models,
  capabilities,
  testIssue,
  menu,
  onChange,
}: {
  step: FlowStep;
  steps: FlowStep[];
  trigger: RoutineTrigger;
  /** "edited in this draft", "new in this draft", or nothing. */
  status: string | null;
  problems: string[];
  models: ModelOption[];
  capabilities: ModelCapabilities | null;
  /** The issue a Test run would use, for the agent step's note. */
  testIssue: string | null;
  menu: ReactNode;
  onChange: (step: FlowStep) => void;
}) {
  const fields = fieldsBefore(steps, step.id, trigger.kind);
  const set = (patch: Partial<FlowStep>) => onChange({ ...step, ...patch } as FlowStep);
  return (
    <InspectorCard
      kind={step.kind}
      title={step.name || "Untitled step"}
      subtitle={status ? `${KIND_WORDS[step.kind]}, ${status}` : KIND_WORDS[step.kind]}
      menu={menu}
      data-flow-inspector={step.id}
    >
      {problems.length > 0 && (
        <div data-flow-problems className="space-y-1 rounded-control bg-red-tint px-3 py-2">
          {problems.map((problem) => (
            <p key={problem} className="flex items-start gap-2 text-12 text-red-ink">
              <HugeiconsIcon icon={Alert02Icon} size={14} strokeWidth={1.8} color="currentColor" className="mt-px shrink-0" />
              {problem}
            </p>
          ))}
        </div>
      )}
      {step.kind === "agent" && <AgentFields step={step} steps={steps} fields={fields} models={models} capabilities={capabilities} set={set} />}
      {step.kind === "if" && <IfFields step={step} fields={fields} set={set} />}
      {step.kind === "ask" && <AskFields step={step} fields={fields} set={set} />}
      {step.kind === "wait" && <WaitFields step={step} set={set} />}
      {step.kind === "pull-request" && <PullRequestFields step={step} fields={fields} set={set} />}
      {step.kind === "linear-comment" && <CommentFields step={step} fields={fields} set={set} />}
      {step.kind === "agent" && (
        <p data-flow-test-note className="flex items-start gap-2 rounded-control bg-page px-3 py-2 text-12 text-ink-2">
          <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={1.8} color="currentColor" className="mt-px shrink-0 text-ink-3" />
          {testIssue ? `Test run uses ${testIssue}, the last issue this flow ran on.` : "Test run uses sample or saved fields."} It is a dry run: agents use
          sample or saved fields; actions and waits do not run.
        </p>
      )}
    </InspectorCard>
  );
}

/** The trigger's inspector: what it gives the steps, and where to change it. */
export function TriggerInspector({ trigger, text, onSettings }: { trigger: RoutineTrigger; text: string; onSettings: () => void }) {
  const gives = triggerFields(trigger.kind);
  return (
    <InspectorCard kind="trigger" title={triggerTitle(trigger)} subtitle={`Trigger, ${text}`} data-flow-inspector="trigger">
      {gives.length > 0 && (
        <Labeled label="Gives every step">
          <div className="flex flex-wrap gap-1.5">
            {gives.map((field) => (
              <FieldChip key={field.ref} icon={FIELD_ICON[field.type] ?? CodeIcon} label={field.label} />
            ))}
          </div>
        </Labeled>
      )}
      <p className="text-12 text-ink-3">
        A step reads one as {"{{trigger.<field>}}"}, for example {`{{${gives[0]?.ref ?? "trigger.time"}}}`}.
      </p>
      <button
        type="button"
        onClick={onSettings}
        className="inline-flex h-8 items-center rounded-control border border-line-strong bg-surface px-3 text-13 font-medium text-ink transition-colors hover:bg-hover"
      >
        Change it in Settings
      </button>
    </InspectorCard>
  );
}
