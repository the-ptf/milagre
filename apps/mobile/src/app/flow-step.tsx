import { Children, useState, type ReactNode } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Add01Icon,
  ArrowDown02Icon,
  ArrowRight01Icon,
  ArrowUp02Icon,
  BubbleChatIcon,
  Cancel01Icon,
  Clock01Icon,
  Delete02Icon,
  GitBranchIcon,
  HourglassIcon,
  Refresh01Icon,
  Shield01Icon,
  SparklesIcon,
  Alert02Icon,
  TextIcon,
} from "@hugeicons/core-free-icons";
import {
  FLOW_LIMITS,
  durationText,
  fieldsBefore,
  findStep,
  flattenSteps,
  flowProblems,
  moveStep,
  removeStep,
  replaceStep,
  stepTitle,
  stepType,
  usedBy,
  type FlowReadable,
} from "@milagre/shared/routine-flows";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import { pickerProviders, providerName } from "@milagre/shared/providers";
import type {
  FlowAgentStep,
  FlowAskStep,
  FlowCommentStep,
  FlowField,
  FlowIfStep,
  FlowPullRequestStep,
  FlowStep,
  FlowWaitStep,
  ModelProvider,
  PermissionMode,
} from "@milagre/shared/model";
import { useSession } from "../session";
import { useRoutines } from "../use-routines";
import { useFlowDraft } from "../flow-draft";
import { modelsFor } from "../turn-options";
import { PlaceholderField } from "../placeholder-field";
import { confirm } from "../confirm-store";
import { FlowButton } from "../flow-ui";
import { Icon, type IconData } from "../icons";
import { CircleButton, ErrorNotice, Field, PageScroll, PullDown, Toggle, useStyles } from "../ui";
import { useTheme } from "../theme";

const DEFAULT = "__default";
const FIELD_TYPES: { id: FlowField["type"]; title: string }[] = [
  { id: "text", title: "Text" },
  { id: "choice", title: "Choice" },
  { id: "yes-no", title: "Yes or no" },
  { id: "number", title: "Number" },
  { id: "link", title: "Link" },
];
const TESTS: { id: FlowIfStep["test"]; title: string }[] = [
  { id: "is", title: "is" },
  { id: "is-not", title: "is not" },
  { id: "contains", title: "contains" },
  { id: "is-set", title: "is set" },
];
const WAITS: { id: FlowWaitStep["until"]["kind"]; title: string }[] = [
  { id: "time", title: "A time" },
  { id: "linear-state", title: "A Linear state" },
  { id: "pr-review", title: "A PR review" },
];
const shows = (value: string) => ({ systemImage: "chevron.right", title: value });

/**
 * The step editor: a step's name and the settings its type has (an agent's prompt, model, Chat, retries and output fields;
 * an If's test; an approval's message and time limit; a wait; a pull request; a Linear comment), then Move up, Move down
 * and Delete. Each change goes into the draft at once and is written once typing rests; the step's problems show on top.
 */
export default function FlowStepSheet() {
  const params = useLocalSearchParams<{ id: string; step: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const { client } = session;
  const routines = useRoutines(client);
  const routine = routines.routines.find((item) => item.id === params.id);
  const draft = useFlowDraft(client, routine, routines.update);
  const step = findStep(draft.steps, params.step);
  const triggerKind = routine?.trigger.kind;

  if (!routine || !step)
    return (
      <View collapsable={false} style={styles.screen}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header title="Step" />
        <View style={{ padding: 20 }}>
          <Text style={styles.muted}>{routines.loading ? "Loading…" : "This step is no longer in the draft."}</Text>
        </View>
      </View>
    );

  const problems = flowProblems(draft.steps, triggerKind).filter((item) => item.stepId === step.id);
  const fields = fieldsBefore(draft.steps, step.id, triggerKind);
  const placeholders = fields.map((field) => ({ name: field.ref, example: `${field.stepName}, ${fieldTypeName(field.type)}` }));
  const change = (next: FlowStep) => draft.edit(replaceStep(draft.steps, step.id, next));
  const entry = flattenSteps(draft.steps).find((item) => item.step.id === step.id);
  const siblings = entry?.parentId ? ((findStep(draft.steps, entry.parentId) as FlowIfStep | null)?.[entry.branch ?? "yes"] ?? []) : draft.steps;
  const first = (entry?.index ?? 0) === 0;
  const last = (entry?.index ?? 0) >= siblings.length - 1;

  async function remove() {
    if (!step) return;
    const inside = step.kind === "if" ? flattenSteps([...step.yes, ...step.otherwise]).length : 0;
    const readers = step.kind === "agent" ? step.output.reduce((sum, field) => sum + usedBy(draft.steps, `${step.id}.${field.name}`), 0) : 0;
    const message = inside
      ? `${inside === 1 ? "The step" : `The ${inside} steps`} on its paths go too.`
      : readers
        ? `${readers === 1 ? "A later step reads" : `${readers} later steps read`} its fields; fix them before publishing.`
        : "It leaves the draft; the published flow keeps it until you publish.";
    if (!(await confirm(`Delete ${stepTitle(step)}?`, message, "Delete step"))) return;
    draft.edit(removeStep(draft.steps, step.id));
    router.back();
  }

  return (
    <View collapsable={false} style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <PageScroll
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 0, gap: 0, paddingBottom: Math.max(insets.bottom, 20) + 12 }}
        stickyHeaderIndices={[0]}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <Header title={stepType(step.kind)?.name ?? "Step"} />
        <View style={{ padding: 20, paddingTop: 8, gap: 12 }}>
          {draft.error ? <ErrorNotice message={`The draft isn't saved: ${draft.error}`} /> : null}
          {problems.map((problem) => (
            <View key={problem.message} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", paddingHorizontal: 4 }}>
              <Icon icon={Alert02Icon} tone="redInk" size={16} />
              <Text accessibilityRole="alert" style={{ flex: 1, color: colors.redInk, fontSize: 13, lineHeight: 18 }}>
                {problem.message}
              </Text>
            </View>
          ))}
          <Label text="Name" />
          <Field
            label="Name"
            hideLabel
            autoCapitalize="sentences"
            maxLength={FLOW_LIMITS.name}
            placeholder="Name this step"
            value={step.name}
            onChangeText={(name) => change({ ...step, name })}
          />
          {step.kind === "agent" ? (
            <AgentFields step={step} fields={fields} placeholders={placeholders} onChange={change} steps={draft.steps} />
          ) : step.kind === "if" ? (
            <IfFields step={step} fields={fields} onChange={change} />
          ) : step.kind === "ask" ? (
            <AskFields step={step} fields={fields} placeholders={placeholders} onChange={change} />
          ) : step.kind === "wait" ? (
            <WaitFields step={step} onChange={change} />
          ) : step.kind === "pull-request" ? (
            <PullRequestFields step={step} fields={fields} placeholders={placeholders} onChange={change} />
          ) : (
            <CommentFields step={step} fields={fields} placeholders={placeholders} onChange={change} />
          )}
          <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
            <FlowButton
              title="Move up"
              kind="secondary"
              icon={ArrowUp02Icon}
              disabled={first}
              onPress={() => draft.edit(moveStep(draft.steps, step.id, -1))}
              style={{ flex: 1 }}
            />
            <FlowButton
              title="Move down"
              kind="secondary"
              icon={ArrowDown02Icon}
              disabled={last}
              onPress={() => draft.edit(moveStep(draft.steps, step.id, 1))}
              style={{ flex: 1 }}
            />
          </View>
          <FlowButton title="Delete step" kind="danger" icon={Delete02Icon} onPress={() => void remove()} />
          <Text style={[styles.caption, { paddingHorizontal: 4, fontSize: 13, lineHeight: 18 }]}>
            Changes save to the draft as you type. Runs use them once you publish.
          </Text>
        </View>
      </PageScroll>
    </View>
  );
}

const fieldTypeName = (type: FlowField["type"]) => FIELD_TYPES.find((item) => item.id === type)?.title.toLowerCase() ?? type;

/** The sheet's sticky header: Close on the leading edge, the step type in the middle. */
function Header({ title }: { title: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ backgroundColor: colors.page }}>
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 60, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 }}>
        <Text
          accessibilityRole="header"
          pointerEvents="none"
          numberOfLines={1}
          style={{
            position: "absolute",
            left: 72,
            right: 72,
            top: 14,
            bottom: 6,
            textAlign: "center",
            lineHeight: 40,
            color: colors.ink,
            fontSize: 17,
            fontWeight: "600",
          }}
        >
          {title}
        </Text>
        <CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />
      </View>
    </View>
  );
}

function Label({ text, trailing }: { text: string; trailing?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 4, marginTop: 6, minHeight: 24 }}>
      <Text style={[styles.label, { flex: 1 }]}>{text}</Text>
      {trailing}
    </View>
  );
}

/** A card of rows split by hairlines. */
function Card({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
      {Children.toArray(children)
        .filter(Boolean)
        .map((child, index) => (
          <View key={(child as { key?: string }).key ?? String(index)}>
            {index > 0 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line }} /> : null}
            {child}
          </View>
        ))}
    </View>
  );
}

/** One setting: its icon and name, then its value and a chevron, or an input in their place. */
function Row({ icon, label, value, children }: { icon: IconData; label: string; value?: string; children?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View
      accessible={!children}
      accessibilityLabel={children ? undefined : `${label}: ${value ?? ""}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingVertical: Platform.OS === "ios" ? 12 : 10 }}
    >
      <Icon icon={icon} tone="ink" size={20} />
      <Text style={{ color: colors.ink, fontSize: 15, fontWeight: "500" }}>{label}</Text>
      {children ? (
        <View style={{ flex: 1, alignItems: "flex-end" }}>{children}</View>
      ) : (
        <>
          <Text numberOfLines={1} style={{ flex: 1, textAlign: "right", color: colors.ink2, fontSize: 15 }}>
            {value}
          </Text>
          <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
        </>
      )}
    </View>
  );
}

/** A whole number typed in place; an empty or partial entry stays on screen and isn't written until it is a number. */
function NumberField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (value: number) => void; min: number; max: number }) {
  const { colors } = useTheme();
  const [text, setText] = useState(String(value));
  const [shownFor, setShownFor] = useState(value);
  // A change from elsewhere (Move, a reload) shows the stored value again.
  if (shownFor !== value && Number(text) !== value) {
    setShownFor(value);
    setText(String(value));
  }
  return (
    <Field
      label={label}
      hideLabel
      keyboardType="number-pad"
      value={text}
      onChangeText={(next) => {
        const digits = next.replace(/\D/g, "");
        setText(digits);
        const number = Number(digits);
        if (digits && number >= min && number <= max) {
          setShownFor(number);
          onChange(number);
        }
      }}
      style={{ backgroundColor: "transparent", color: colors.ink2, textAlign: "right", paddingHorizontal: 0, minWidth: 80, fontSize: 15 }}
    />
  );
}

/** "Insert field": the fields this step can read, searchable; a pick appends `{{ref}}` to the text. */
function InsertField({ fields, onInsert }: { fields: FlowReadable[]; onInsert: (ref: string) => void }) {
  const { colors } = useTheme();
  if (!fields.length) return null;
  return (
    <PullDown
      label="Insert field"
      title="Insert field"
      searchable={{ placeholder: "Search fields", emptyLabel: "No matching fields" }}
      nativeTrigger={shows("Insert field")}
      sections={[{ items: fields.map((field) => ({ id: field.ref, title: field.ref, subtitle: `${field.stepName}, ${fieldTypeName(field.type)}` })) }]}
      onSelect={onInsert}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4 }}>
        <Icon icon={Add01Icon} tone="accentInk" size={14} />
        <Text style={{ color: colors.accentInk, fontSize: 13, fontWeight: "500" }}>Insert field</Text>
      </View>
    </PullDown>
  );
}

const append = (text: string, ref: string) => `${text}${text && !/\s$/.test(text) ? " " : ""}{{${ref}}}`;
type Placeholders = { name: string; example: string }[];

function AgentFields({
  step,
  steps,
  fields,
  placeholders,
  onChange,
}: {
  step: FlowAgentStep;
  steps: FlowStep[];
  fields: FlowReadable[];
  placeholders: Placeholders;
  onChange: (next: FlowStep) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSession();
  const providers = pickerProviders(session.cliStatus, ...(step.provider ? [step.provider] : []));
  const models = providers.flatMap((provider) => modelsFor(provider, session.models).map((model) => ({ ...model, provider })));
  const model = models.find((item) => item.provider === step.provider && item.id === step.model);
  const modelText = model?.name ?? (step.model || "Default");
  const mode = PERMISSION_MODES.find((item) => item.id === step.permissionMode);
  const set = (patch: Partial<FlowAgentStep>) => onChange({ ...step, ...patch });
  const setField = (index: number, patch: Partial<FlowField>) =>
    set({ output: step.output.map((field, at) => (at === index ? { ...field, ...patch } : field)) });
  const newFieldName = () => {
    const taken = new Set(step.output.map((field) => field.name));
    for (let n = 1; ; n++) if (!taken.has(n === 1 ? "result" : `result${n}`)) return n === 1 ? "result" : `result${n}`;
  };
  return (
    <>
      <Label text="Prompt" trailing={<InsertField fields={fields} onInsert={(ref) => set({ prompt: append(step.prompt, ref) })} />} />
      <PlaceholderField
        value={step.prompt}
        onChangeText={(prompt) => set({ prompt })}
        placeholders={placeholders}
        placeholder="What the agent should do in this step"
      />
      <Text style={[styles.caption, { paddingHorizontal: 4 }]}>Type {"{{"} to read a field from the trigger or an earlier step.</Text>
      <Card>
        <PullDown
          label="Model"
          title="Model"
          searchable={{ placeholder: "Search models", emptyLabel: "No matching models" }}
          nativeTrigger={shows(modelText)}
          sections={[
            {
              items: [
                { id: DEFAULT, title: "Default", subtitle: "The Mac's default model", checked: !step.model },
                ...models.map((item) => ({
                  id: `${item.provider}:${item.id}`,
                  title: item.name,
                  subtitle: providerName(item.provider),
                  checked: item === model,
                })),
              ],
            },
          ]}
          onSelect={(choice) => {
            if (choice === DEFAULT) {
              const { provider: _provider, model: _model, effort: _effort, ...rest } = step;
              onChange(rest as FlowAgentStep);
            } else {
              const split = choice.indexOf(":");
              const { effort: _effort, ...rest } = step;
              onChange({ ...rest, provider: choice.slice(0, split) as ModelProvider, model: choice.slice(split + 1) });
            }
          }}
        >
          <Row icon={SparklesIcon} label="Model" value={modelText} />
        </PullDown>
        <PullDown
          label="Permissions"
          title="Permissions"
          sections={[
            {
              items: [
                { id: DEFAULT, title: "Default", checked: !step.permissionMode },
                ...PERMISSION_MODES.map((item) => ({ id: item.id, title: item.name, subtitle: item.description, checked: item.id === step.permissionMode })),
              ],
            },
          ]}
          onSelect={(choice) => {
            if (choice === DEFAULT) {
              const { permissionMode: _mode, ...rest } = step;
              onChange(rest as FlowAgentStep);
            } else set({ permissionMode: choice as PermissionMode });
          }}
        >
          <Row icon={Shield01Icon} label="Permissions" value={mode?.name ?? "Default"} />
        </PullDown>
        <PullDown
          label="Chat"
          title="Works in"
          sections={[
            {
              items: [
                { id: "run", title: "The Run's Chat", subtitle: "Shares the Run's Worktree and history", checked: step.chat !== "own" },
                { id: "own", title: "A Chat of its own", subtitle: "Same Worktree, a fresh Chat", checked: step.chat === "own" },
              ],
            },
          ]}
          onSelect={(chat) => set({ chat: chat === "own" ? "own" : "run" })}
        >
          <Row icon={BubbleChatIcon} label="Chat" value={step.chat === "own" ? "Its own Chat" : "Run Chat"} />
        </PullDown>
        <PullDown
          label="Retries"
          title="Retries after a failed turn"
          sections={[
            {
              items: Array.from({ length: FLOW_LIMITS.retries + 1 }, (_, count) => ({
                id: String(count),
                title: count === 0 ? "None" : count === 1 ? "1 retry" : `${count} retries`,
                checked: step.retries === count,
              })),
            },
          ]}
          onSelect={(count) => set({ retries: Number(count) })}
        >
          <Row icon={Refresh01Icon} label="Retries" value={step.retries === 0 ? "None" : String(step.retries)} />
        </PullDown>
        <PullDown
          label="If the output is invalid"
          title="If the output is invalid"
          sections={[
            {
              items: [
                { id: "ask-once", title: "Ask once more", subtitle: "Sends one follow-up asking for the fields", checked: step.onInvalid !== "stop" },
                { id: "stop", title: "Stop the step", subtitle: "Counts as a failed turn", checked: step.onInvalid === "stop" },
              ],
            },
          ]}
          onSelect={(choice) => set({ onInvalid: choice === "stop" ? "stop" : "ask-once" })}
        >
          <Row icon={Alert02Icon} label="If invalid" value={step.onInvalid === "stop" ? "Stop" : "Ask once more"} />
        </PullDown>
      </Card>

      <Label text="Output fields" />
      <Text style={[styles.caption, { paddingHorizontal: 4, marginTop: -6 }]}>
        {`What the agent hands back. Later steps read them as {{${step.id}.<name>}}.`}
      </Text>
      {step.output.map((field, index) => {
        const readers = usedBy(steps, `${step.id}.${field.name}`);
        return (
          <View key={index} style={[styles.card, { gap: 10, padding: 14 }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Field name"
                  hideLabel
                  placeholder="name"
                  value={field.name}
                  onChangeText={(name) => setField(index, { name: name.replace(/\s/g, "_") })}
                />
              </View>
              <PullDown
                label="Type"
                title="Type"
                sections={[{ items: FIELD_TYPES.map((item) => ({ id: item.id, title: item.title, checked: item.id === field.type })) }]}
                onSelect={(type) => {
                  const next: FlowField = { ...field, type: type as FlowField["type"] };
                  if (type === "choice") next.choices = field.choices?.length ? field.choices : ["", ""];
                  else delete next.choices;
                  setField(index, next);
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    height: 44,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    backgroundColor: colors.field,
                  }}
                >
                  <Text style={{ color: colors.ink, fontSize: 15 }}>{FIELD_TYPES.find((item) => item.id === field.type)?.title ?? field.type}</Text>
                  <Icon icon={ArrowRight01Icon} tone="ink3" size={14} />
                </View>
              </PullDown>
            </View>
            {field.type === "choice" ? (
              <Field
                label="Choices"
                hideLabel
                placeholder="small, medium, large"
                value={(field.choices ?? []).join(", ")}
                onChangeText={(text) => setField(index, { choices: text.split(",").map((choice) => choice.trimStart()) })}
              />
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={[styles.caption, { flex: 1, fontSize: 13 }]}>
                {readers ? `Read by ${readers} ${readers === 1 ? "step" : "steps"}` : "No step reads it yet"}
              </Text>
              <FlowButton title="Remove" kind="quiet" compact onPress={() => set({ output: step.output.filter((_, at) => at !== index) })} />
            </View>
          </View>
        );
      })}
      {step.output.length < FLOW_LIMITS.fields ? (
        <FlowButton
          title="Add field"
          kind="secondary"
          icon={Add01Icon}
          onPress={() => set({ output: [...step.output, { name: newFieldName(), type: "text" }] })}
        />
      ) : null}
    </>
  );
}

function IfFields({ step, fields, onChange }: { step: FlowIfStep; fields: FlowReadable[]; onChange: (next: FlowStep) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const set = (patch: Partial<FlowIfStep>) => onChange({ ...step, ...patch });
  const field = fields.find((item) => item.ref === step.field);
  const options = field?.type === "choice" ? (field.choices ?? []) : field?.type === "yes-no" ? ["yes", "no"] : [];
  return (
    <>
      <Label text="Test" />
      <Card>
        <PullDown
          label="Field"
          title="Field"
          searchable={{ placeholder: "Search fields", emptyLabel: "No earlier step gives a field yet" }}
          nativeTrigger={shows(step.field || "Choose")}
          sections={[
            {
              items: fields.map((item) => ({
                id: item.ref,
                title: item.ref,
                subtitle: `${item.stepName}, ${fieldTypeName(item.type)}`,
                checked: item.ref === step.field,
              })),
            },
          ]}
          onSelect={(ref) => set({ field: ref })}
        >
          <Row icon={TextIcon} label="Field" value={step.field || "Choose"} />
        </PullDown>
        <PullDown
          label="Test"
          title="Test"
          sections={[{ items: TESTS.map((item) => ({ id: item.id, title: item.title, checked: item.id === step.test })) }]}
          onSelect={(test) => {
            const next: FlowIfStep = { ...step, test: test as FlowIfStep["test"] };
            if (test === "is-set") delete next.value;
            else next.value = step.value ?? "";
            onChange(next);
          }}
        >
          <Row icon={GitBranchIcon} label="Test" value={TESTS.find((item) => item.id === step.test)?.title ?? step.test} />
        </PullDown>
        {step.test === "is-set" ? null : options.length ? (
          <PullDown
            label="Value"
            title="Value"
            sections={[{ items: options.map((option) => ({ id: option, title: option, checked: option === step.value })) }]}
            onSelect={(value) => set({ value })}
          >
            <Row icon={TextIcon} label="Value" value={step.value || "Choose"} />
          </PullDown>
        ) : (
          <Row icon={TextIcon} label="Value">
            <Field
              label="Value"
              hideLabel
              placeholder="large"
              value={step.value ?? ""}
              onChangeText={(value) => set({ value })}
              style={{ backgroundColor: "transparent", color: colors.ink2, textAlign: "right", paddingHorizontal: 0, minWidth: 140, fontSize: 15 }}
            />
          </Row>
        )}
      </Card>
      <Text style={[styles.caption, { paddingHorizontal: 4, fontSize: 13, lineHeight: 18 }]}>
        Yes runs when the test holds, Otherwise when it does not. Separate values with commas to match any of them. Add steps to each path in the Steps list.
      </Text>
    </>
  );
}

function AskFields({
  step,
  fields,
  placeholders,
  onChange,
}: {
  step: FlowAskStep;
  fields: FlowReadable[];
  placeholders: Placeholders;
  onChange: (next: FlowStep) => void;
}) {
  const styles = useStyles();
  const set = (patch: Partial<FlowAskStep>) => onChange({ ...step, ...patch });
  return (
    <>
      <Label text="Message" trailing={<InsertField fields={fields} onInsert={(ref) => set({ message: append(step.message, ref) })} />} />
      <PlaceholderField
        value={step.message}
        onChangeText={(message) => set({ message })}
        placeholders={placeholders}
        placeholder="What you are asked to approve"
      />
      <Card>
        <Row icon={Clock01Icon} label="Hours to answer">
          <NumberField
            label="Hours to answer"
            value={step.expiresInHours}
            min={1}
            max={FLOW_LIMITS.askHours}
            onChange={(expiresInHours) => set({ expiresInHours })}
          />
        </Row>
      </Card>
      <Text style={[styles.caption, { paddingHorizontal: 4, fontSize: 13, lineHeight: 18 }]}>
        {`You can answer on any device. Rejected, or no answer within ${step.expiresInHours} h, ends the Run.`}
      </Text>
    </>
  );
}

function WaitFields({ step, onChange }: { step: FlowWaitStep; onChange: (next: FlowStep) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const until = step.until;
  return (
    <>
      <Label text="Wait for" />
      <Card>
        <PullDown
          label="Wait for"
          title="Wait for"
          sections={[{ items: WAITS.map((item) => ({ id: item.id, title: item.title, checked: item.id === until.kind })) }]}
          onSelect={(kind) =>
            onChange({
              ...step,
              until: kind === "time" ? { kind: "time", minutes: 60 } : kind === "linear-state" ? { kind: "linear-state", state: "" } : { kind: "pr-review" },
            })
          }
        >
          <Row icon={HourglassIcon} label="Wait for" value={WAITS.find((item) => item.id === until.kind)?.title ?? ""} />
        </PullDown>
        {until.kind === "time" ? (
          <Row icon={Clock01Icon} label="Minutes">
            <NumberField
              label="Minutes"
              value={until.minutes}
              min={1}
              max={FLOW_LIMITS.waitMinutes}
              onChange={(minutes) => onChange({ ...step, until: { kind: "time", minutes } })}
            />
          </Row>
        ) : null}
        {until.kind === "linear-state" ? (
          <Row icon={GitBranchIcon} label="State">
            <Field
              label="State"
              hideLabel
              autoCapitalize="words"
              placeholder="In Review"
              value={until.state}
              onChangeText={(state) => onChange({ ...step, until: { kind: "linear-state", state } })}
              style={{ backgroundColor: "transparent", color: colors.ink2, textAlign: "right", paddingHorizontal: 0, minWidth: 140, fontSize: 15 }}
            />
          </Row>
        ) : null}
        {until.kind === "time" ? null : (
          <Row icon={Clock01Icon} label="Time limit, hours">
            <NumberField
              label="Time limit in hours"
              value={step.timeoutHours}
              min={1}
              max={FLOW_LIMITS.timeoutHours}
              onChange={(timeoutHours) => onChange({ ...step, timeoutHours })}
            />
          </Row>
        )}
      </Card>
      <Text style={[styles.caption, { paddingHorizontal: 4, fontSize: 13, lineHeight: 18 }]}>
        {until.kind === "time"
          ? `The Run goes on after ${durationText(until.minutes)}.`
          : until.kind === "linear-state"
            ? `The Run goes on once the issue is ${until.state || "in that state"}. After ${step.timeoutHours} h the step fails.`
            : `The Run goes on once its pull request is reviewed. After ${step.timeoutHours} h the step fails.`}
      </Text>
    </>
  );
}

function PullRequestFields({
  step,
  fields,
  placeholders,
  onChange,
}: {
  step: FlowPullRequestStep;
  fields: FlowReadable[];
  placeholders: Placeholders;
  onChange: (next: FlowStep) => void;
}) {
  const styles = useStyles();
  const set = (patch: Partial<FlowPullRequestStep>) => onChange({ ...step, ...patch });
  return (
    <>
      <Label text="Title" trailing={<InsertField fields={fields} onInsert={(ref) => set({ title: append(step.title, ref) })} />} />
      <Field
        label="Title"
        hideLabel
        autoCapitalize="sentences"
        placeholder="{{trigger.issue.key}} {{trigger.issue.title}}"
        value={step.title}
        onChangeText={(title) => set({ title })}
      />
      <Label text="Description" trailing={<InsertField fields={fields} onInsert={(ref) => set({ body: append(step.body, ref) })} />} />
      <PlaceholderField value={step.body} onChangeText={(body) => set({ body })} placeholders={placeholders} placeholder="What the pull request does" />
      <Label text="Base branch" />
      <Field
        label="Base branch"
        hideLabel
        placeholder="The repository's default branch"
        value={step.base ?? ""}
        onChangeText={(base) => {
          if (base) set({ base });
          else {
            const { base: _base, ...rest } = step;
            onChange(rest);
          }
        }}
      />
      <View style={[styles.card, { gap: 4, paddingVertical: 8 }]}>
        <Toggle title="Open as a draft" selected={step.draft} onPress={() => set({ draft: !step.draft })} />
        <Toggle title="Ask me first" selected={step.askFirst} onPress={() => set({ askFirst: !step.askFirst })} />
      </View>
      <Text style={[styles.caption, { paddingHorizontal: 4, fontSize: 13, lineHeight: 18 }]}>
        Pushes the branch for this Run and opens the pull request once. It keeps a receipt, so a restart or a retry never opens a second one.
      </Text>
    </>
  );
}

function CommentFields({
  step,
  fields,
  placeholders,
  onChange,
}: {
  step: FlowCommentStep;
  fields: FlowReadable[];
  placeholders: Placeholders;
  onChange: (next: FlowStep) => void;
}) {
  const styles = useStyles();
  const set = (patch: Partial<FlowCommentStep>) => onChange({ ...step, ...patch });
  return (
    <>
      <Label text="Comment" trailing={<InsertField fields={fields} onInsert={(ref) => set({ body: append(step.body, ref) })} />} />
      <PlaceholderField value={step.body} onChangeText={(body) => set({ body })} placeholders={placeholders} placeholder="What to post on the issue" />
      <Text style={[styles.caption, { paddingHorizontal: 4, fontSize: 13, lineHeight: 18 }]}>Posts on the Linear issue for this Run, once per Run.</Text>
    </>
  );
}
