import { Children, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import {
  Add01Icon,
  ArrowRight01Icon,
  Calendar01Icon,
  Cancel01Icon,
  Clock01Icon,
  Copy01Icon,
  Flag02Icon,
  FlashIcon,
  Folder01Icon,
  GitBranchIcon,
  Globe02Icon,
  Link02Icon,
  PencilEdit02Icon,
  Refresh01Icon,
  RepeatIcon,
  Shield01Icon,
  SparklesIcon,
  Tag01Icon,
  UserMultipleIcon,
  WebhookIcon,
  Exchange01Icon,
  BubbleChatIcon,
} from "@hugeicons/core-free-icons";
import {
  EVERY_HOURS,
  EVERY_MINUTES,
  emptyRoutineForm,
  fallbackApplies,
  formFromRoutine,
  formToInput,
  formToUpdate,
  deleteWarning,
  isCommentRoutine,
  promptHint,
  PROMPT_PLACEHOLDER,
  withRunIn,
  type RoutineFormField,
  type RoutineFormProblem,
  type RoutineFormState,
  type RoutineLinearEvent,
} from "@milagre/shared/routine-form";
import { placeholdersFor } from "@milagre/shared/routine-prompt";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import { pickerProviders, providerName } from "@milagre/shared/providers";
import type { ModelProvider, RoutineTrigger } from "@milagre/shared/model";
import { useSession } from "../session";
import { useRoutines } from "../use-routines";
import { useRpc } from "../use-rpc";
import { modelsFor } from "../turn-options";
import { PlaceholderField } from "../placeholder-field";
import { confirm } from "../confirm-store";
import { Icon, type IconData } from "../icons";
import { Button, CircleButton, ErrorNotice, Field, PageScroll, PillButton, PullDown, RowCheckbox, useStyles } from "../ui";
import { useTheme } from "../theme";

type Targets = { projects: { path: string; name: string; chats: { chatId: string; title: string; lastAt?: number }[] }[] };
type LinearOptions = {
  workspaces: { id: string; name: string }[];
  teams: { key: string; name: string }[];
  labels: string[];
  states: { name: string; type: string }[];
};
type Hook = { url: string; signed: boolean; signingHeader?: string };

const DAY_MS = 864e5;
const ANY_TEAM = "__any";
const DEFAULT = "__default";
const TRIGGERS: { id: RoutineFormState["trigger"]; label: string; icon: IconData }[] = [
  { id: "schedule", label: "On a schedule", icon: Clock01Icon },
  { id: "linear", label: "Linear event", icon: Tag01Icon },
  { id: "webhook", label: "Webhook", icon: WebhookIcon },
];
const EVENTS: { id: RoutineLinearEvent; title: string }[] = [
  { id: "label-added", title: "Label added" },
  { id: "assigned", title: "Assigned to me" },
  { id: "state", title: "Moved to a state" },
  { id: "comment", title: "New comment" },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const ENDS_IN = [1, 3, 7, 14, 30];
const RUN_IN: { id: RoutineFormState["runIn"]; title: string }[] = [
  { id: "worktree", title: "New Worktree" },
  { id: "project", title: "Project folder" },
  { id: "chat", title: "An existing Chat" },
];

const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
/** The zones Hermes knows, when it lists them (read once); without the list the timezone stays as it is. */
let zoneList: string[] | null = null;
function timezones(): string[] {
  if (zoneList) return zoneList;
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    zoneList = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zoneList = [];
  }
  return zoneList;
}
/** A searchable picker's trigger: VoiceOver reads the row as "label: value", as it shows. */
const shows = (value: string, disabled = false) => ({ systemImage: "chevron.right", title: value, disabled });
const daysText = (days: number[]) => {
  if (days.length === 7) return "Every day";
  if (days.length === 5 && WEEKDAYS.every((day) => days.includes(day))) return "Weekdays";
  return days.length ? DAYS.filter((_, index) => days.includes(index)).join(", ") : "No days";
};
const dateText = (at: number) => {
  const date = new Date(at);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()]} ${date.getDate()}`;
};

/**
 * The New Routine sheet (and Edit, with `id`), the phone's side of desktop's in-place form: the name, how it starts (new
 * only), its settings as rows (the schedule or event, where each Run lands, the model and mode), the prompt, Stop after,
 * and Delete Routine at the bottom of Edit. Small fixed choices are pull-downs; Projects, Chats, teams, labels, states and
 * models open the searchable choice sheet.
 */
export default function RoutineFormSheet() {
  const params = useLocalSearchParams<{ id?: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const { client } = session;
  const routines = useRoutines(client);
  // A webhook Routine just created stays open on its URL, so it can be copied; from then on the sheet edits it.
  const [createdId, setCreatedId] = useState("");
  const id = params.id || createdId;
  const routine = id ? routines.routines.find((item) => item.id === id) : undefined;
  const [now] = useState(() => Date.now());
  const [form, setForm] = useState<RoutineFormState>(() => emptyRoutineForm(deviceTimezone(), now));
  const [loadedFor, setLoadedFor] = useState("");
  const [hookUrl, setHookUrl] = useState("");
  const [problem, setProblem] = useState<RoutineFormProblem | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [footerHeight, setFooterHeight] = useState(0);
  // Whether the user changed anything (reads the sheet fills in itself don't count): closing it then asks to discard.
  const [dirty, setDirty] = useState(false);
  const [closing, setClosing] = useState(false);
  usePreventRemove(dirty && !closing, ({ repeat }) =>
    Alert.alert("Discard changes?", "Your changes to this Routine will not be saved.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        // repeat() lifts the prevention before dispatching; dispatching the action again would be blocked again.
        onPress: () => {
          setClosing(true);
          repeat();
        },
      },
    ]),
  );
  // Leaves after a save or a delete, which have nothing left to discard.
  const leave = () => {
    setClosing(true);
    setTimeout(() => router.back(), 0);
  };
  // Editing starts from the stored Routine once the list has it.
  if (routine && loadedFor !== routine.id && !createdId) {
    setLoadedFor(routine.id);
    setForm(formFromRoutine(routine, deviceTimezone(), now));
  }
  const editing = !!routine;
  const targets = useRpc<Targets>(client, "routines:targets", []).data;
  const linearOptions = useRpc<LinearOptions>(form.trigger === "linear" ? client : null, "routines:linear-options", [
    { workspace: form.linear.workspace || undefined, team: form.linear.team || undefined },
  ]).data;
  const hook = useRpc<Hook>(routine?.trigger.kind === "webhook" && client ? client : null, "routines:hook", [routine?.id ?? ""]);
  const url = hookUrl || hook.data?.url || "";
  // The first workspace stands in until one is picked, so a single-workspace Mac never asks.
  const withWorkspace: RoutineFormState =
    form.trigger === "linear" && !form.linear.workspace && linearOptions?.workspaces[0]
      ? { ...form, linear: { ...form.linear, workspace: linearOptions.workspaces[0].id } }
      : form;
  // A comment Routine's Runs go into the Chat linked to the issue, so the form asks for no Project or Each Run. The Mac
  // still keeps a listed Project on it: the one open on the phone, else the first listed, filled in without showing it.
  const commentRoutine = isCommentRoutine(form);
  const currentProject = targets?.projects.find((item) => item.path === session.snapshot?.project.path)?.path ?? targets?.projects[0]?.path ?? "";
  const resolved: RoutineFormState =
    commentRoutine && !withWorkspace.projectPath && currentProject ? { ...withWorkspace, projectPath: currentProject } : withWorkspace;
  // The signing header is read with the URL; it fills the form once, so switching signing off doesn't bring it back.
  const [headerFor, setHeaderFor] = useState("");
  if (hook.data && routine && loadedFor === routine.id && headerFor !== routine.id) {
    setHeaderFor(routine.id);
    if (hook.data.signingHeader && !form.webhook.signingHeader) setForm({ ...form, webhook: { ...form.webhook, signingHeader: hook.data.signingHeader } });
  }

  const change = (patch: Partial<RoutineFormState>) => {
    setDirty(true);
    setProblem(null);
    setForm((current) => ({ ...current, ...patch }));
  };
  const changeLinear = (patch: Partial<RoutineFormState["linear"]>) => change({ linear: { ...resolved.linear, ...patch } });
  const changeSchedule = (patch: Partial<RoutineFormState["schedule"]>) => change({ schedule: { ...form.schedule, ...patch } });
  const problemFor = (...fields: RoutineFormField[]) => (problem && fields.includes(problem.field) ? problem.error : "");

  async function save() {
    if (!client || saving) return;
    setError("");
    const made = routine ? formToUpdate(resolved, routine, Date.now()) : formToInput(resolved, Date.now());
    if (made.field) {
      setProblem({ field: made.field, error: made.error });
      return;
    }
    setSaving(true);
    try {
      if (routine && "patch" in made) {
        await client.call("routines:update", [routine.id, made.patch]);
        await routines.refresh();
        leave();
      } else if ("input" in made && made.input) {
        const result = await client.call<{ routine?: { id: string }; id?: string; hookUrl?: string }>("routines:create", [made.input]);
        await routines.refresh();
        if (result?.hookUrl) {
          setCreatedId(result.routine?.id ?? result.id ?? "");
          setLoadedFor(result.routine?.id ?? result.id ?? "");
          setHookUrl(result.hookUrl);
          // Saved: from here the sheet edits the new Routine, with nothing to discard yet.
          setDirty(false);
        } else leave();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this Routine.");
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!client || !routine) return;
    setError("");
    try {
      if (!(await confirm(`Delete ${routine.name}?`, deleteWarning(routine), "Delete"))) return;
      await client.call("routines:delete", [routine.id]);
      // The Routine's screen behind the sheet sees it gone and leaves too.
      leave();
      await routines.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not delete this Routine.");
    }
  }
  async function rotate() {
    if (!client || !routine) return;
    if (!(await confirm("Rotate the webhook URL?", "The old URL stops working at once.", "Rotate"))) return;
    try {
      const next = await client.call<{ url: string }>("routines:rotate-hook", [routine.id]);
      setHookUrl(next.url);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not rotate the URL.");
    }
  }

  const projects = targets?.projects ?? [];
  const project = projects.find((item) => item.path === (form.runIn === "chat" && form.chatId ? chatProject(form.chatId, projects) : form.projectPath));
  const chat = projects.flatMap((item) => item.chats).find((item) => item.chatId === form.chatId);
  const providers = pickerProviders(session.cliStatus, ...(form.provider ? [form.provider] : []));
  const models = providers.flatMap((provider) => modelsFor(provider, session.models).map((model) => ({ ...model, provider })));
  const model = models.find((item) => item.provider === form.provider && item.id === form.model);
  const mode = PERMISSION_MODES.find((item) => item.id === form.permissionMode);
  // The model a failed Run retries on, and its effort; automatic when none is picked (see fallbackApplies).
  const fallbackModel = models.find((item) => item.provider === form.fallbackProvider && item.id === form.fallbackModel);
  const fallbackName = fallbackModel?.name ?? (form.fallbackModel || "Another provider");
  const fallbackEfforts = fallbackModel?.efforts ?? [];
  const effortName = (effort: string) => `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
  const zones = timezones();
  const placeholders = placeholdersFor(
    (form.trigger === "linear"
      ? { kind: "linear", workspace: resolved.linear.workspace, event: form.linear.event }
      : form.trigger === "webhook"
        ? { kind: "webhook", hookId: "", signed: false }
        : { kind: "schedule", cron: "", timezone: form.schedule.timezone }) as RoutineTrigger,
  );
  const workspaceName = linearOptions?.workspaces.find((item) => item.id === resolved.linear.workspace)?.name ?? resolved.linear.workspace;
  const team = linearOptions?.teams.find((item) => item.key === form.linear.team);
  const teamText = team ? `${team.key} · ${team.name}` : form.linear.team || "Any team";
  const heartbeat = form.runIn === "chat";
  // A webhook checks an HMAC once signing is switched on (or a secret is typed); off clears the header and secret.
  const signed = form.webhook.signed === true || !!form.webhook.signingSecret.trim();
  const title = editing ? (createdId ? "Webhook Routine" : "Edit Routine") : "New Routine";

  return (
    // Keep the form and its footer inside one native view. Flattening this root makes iOS treat its background as a
    // full-height header beside the scroll view, leaving the fields with zero height (as in model-sheet.tsx).
    <View collapsable={false} style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* A form sheet sizes its first scroll view to the sheet, so the header is its sticky first child (as in mcp-add.tsx). */}
      <PageScroll
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 0, gap: 0, paddingBottom: footerHeight }}
        scrollIndicatorInsets={{ bottom: footerHeight }}
        stickyHeaderIndices={[0]}
        automaticallyAdjustKeyboardInsets
      >
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
        <View style={{ padding: 20, paddingTop: 8, gap: 12 }}>
          {error ? <ErrorNotice message={error} /> : null}
          {routines.unavailable ? (
            <Text style={styles.muted}>
              {routines.unavailable === "older" ? "Update Milagre on this Mac to use Routines." : "Routines aren't available on this connection."}
            </Text>
          ) : null}
          {routines.enabled === false ? <Text style={styles.caption}>{"This Mac can't run Routines yet. Saving this one allows it."}</Text> : null}
          <View style={[styles.card, { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 0 }]}>
            <Icon icon={PencilEdit02Icon} tone="ink3" size={20} />
            <View style={{ flex: 1 }}>
              <Field
                label="Name"
                hideLabel
                placeholder="Name this Routine"
                autoCapitalize="sentences"
                value={form.name}
                onChangeText={(name) => change({ name })}
                style={{ backgroundColor: "transparent", paddingHorizontal: 0, fontSize: 16, fontWeight: "500" }}
              />
            </View>
          </View>
          <Problem text={problemFor("name")} />

          {editing ? null : <Text style={[styles.label, { paddingHorizontal: 4, marginTop: 4 }]}>Starts</Text>}
          {/* A Routine's trigger kind can't change, so Edit shows only its rows. */}
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 8, display: editing ? "none" : "flex" }}>
            {TRIGGERS.map((item) => {
              const selected = form.trigger === item.id;
              const locked = editing && !selected;
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="radio"
                  accessibilityLabel={item.label}
                  accessibilityState={{ checked: selected, disabled: locked }}
                  disabled={locked}
                  onPress={() => change(item.id !== "schedule" && heartbeat ? { ...withRunIn(form, "worktree", now), trigger: item.id } : { trigger: item.id })}
                  style={({ pressed }) => ({
                    flex: 1,
                    height: 56,
                    gap: 4,
                    borderRadius: 16,
                    borderCurve: "continuous",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: selected ? colors.ink : "transparent",
                    borderWidth: selected ? 0 : 1,
                    borderColor: colors.lineStrong,
                    opacity: locked ? 0.4 : pressed ? 0.7 : 1,
                  })}
                >
                  <Icon icon={item.icon} tone={selected ? "onInk" : "ink2"} size={20} />
                  <Text style={{ color: selected ? colors.onInk : colors.ink2, fontSize: 13, fontWeight: selected ? "600" : "500" }}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {form.trigger === "schedule" ? (
            <Card>
              <PullDown
                label="Repeats"
                title="Repeats"
                sections={[
                  {
                    title: "Every",
                    items: EVERY_MINUTES.map((value) => ({
                      id: `min:${value}`,
                      title: `${value} min`,
                      checked: form.schedule.mode === "every" && form.schedule.unit === "min" && form.schedule.every === value,
                    })),
                  },
                  {
                    items: EVERY_HOURS.map((value) => ({
                      id: `h:${value}`,
                      title: `${value} h`,
                      checked: form.schedule.mode === "every" && form.schedule.unit === "h" && form.schedule.every === value,
                    })),
                  },
                  {
                    items: [
                      { id: "at", title: "At a time", checked: form.schedule.mode === "at" },
                      { id: "cron", title: "Advanced (cron)", checked: form.schedule.mode === "cron" },
                    ],
                  },
                ]}
                onSelect={(choice) => {
                  if (choice === "at" || choice === "cron") changeSchedule({ mode: choice });
                  else {
                    const [unit, value] = choice.split(":");
                    changeSchedule({ mode: "every", unit: unit === "h" ? "h" : "min", every: Number(value) });
                  }
                }}
              >
                <FormRow
                  icon={RepeatIcon}
                  label="Repeats"
                  value={
                    form.schedule.mode === "every"
                      ? `Every ${form.schedule.every} ${form.schedule.unit}`
                      : form.schedule.mode === "at"
                        ? "At a time"
                        : "Advanced"
                  }
                />
              </PullDown>
              {form.schedule.mode === "at" ? (
                <FormRow icon={Clock01Icon} label="Time">
                  <Field
                    label="Time"
                    hideLabel
                    placeholder="09:00"
                    keyboardType="numbers-and-punctuation"
                    value={form.schedule.time}
                    onChangeText={(time) => changeSchedule({ time })}
                    style={inlineField(colors)}
                  />
                </FormRow>
              ) : null}
              {form.schedule.mode === "at" ? (
                <PullDown
                  label="Days"
                  title="Days"
                  sections={[
                    {
                      items: [
                        { id: "weekdays", title: "Weekdays" },
                        { id: "every", title: "Every day" },
                      ],
                    },
                    { items: DAYS.map((day, index) => ({ id: String(index), title: day, checked: form.schedule.days.includes(index) })) },
                  ]}
                  onSelect={(choice) => {
                    if (choice === "weekdays") changeSchedule({ days: WEEKDAYS });
                    else if (choice === "every") changeSchedule({ days: [0, 1, 2, 3, 4, 5, 6] });
                    else {
                      const day = Number(choice);
                      const days = form.schedule.days.includes(day) ? form.schedule.days.filter((item) => item !== day) : [...form.schedule.days, day];
                      changeSchedule({ days });
                    }
                  }}
                >
                  <FormRow icon={Calendar01Icon} label="Days" value={daysText(form.schedule.days)} />
                </PullDown>
              ) : null}
              {form.schedule.mode === "cron" ? (
                <FormRow icon={Clock01Icon} label="Cron">
                  <Field
                    label="Cron"
                    hideLabel
                    placeholder="*/15 * * * *"
                    value={form.schedule.cron}
                    onChangeText={(cron) => changeSchedule({ cron })}
                    style={inlineField(colors)}
                  />
                </FormRow>
              ) : null}
              {zones.length ? (
                <PullDown
                  label="Timezone"
                  title="Timezone"
                  searchable={{ placeholder: "Search timezones", emptyLabel: "No matching timezones" }}
                  nativeTrigger={shows(form.schedule.timezone)}
                  sections={[{ items: zones.map((zone) => ({ id: zone, title: zone, checked: zone === form.schedule.timezone })) }]}
                  onSelect={(timezone) => changeSchedule({ timezone })}
                >
                  <FormRow icon={Globe02Icon} label="Timezone" value={form.schedule.timezone} />
                </PullDown>
              ) : (
                <FormRow icon={Globe02Icon} label="Timezone" value={form.schedule.timezone} readOnly />
              )}
            </Card>
          ) : null}

          {form.trigger === "linear" ? (
            <Card>
              {(linearOptions?.workspaces.length ?? 0) > 1 ? (
                <PullDown
                  label="Workspace"
                  title="Linear workspace"
                  searchable={{ placeholder: "Search workspaces", emptyLabel: "No matching workspaces" }}
                  nativeTrigger={shows(workspaceName)}
                  sections={[
                    {
                      items: (linearOptions?.workspaces ?? []).map((item) => ({
                        id: item.id,
                        title: item.name,
                        checked: item.id === resolved.linear.workspace,
                      })),
                    },
                  ]}
                  onSelect={(workspace) => changeLinear({ workspace, team: "", label: "", state: "" })}
                >
                  <FormRow icon={Link02Icon} label="Workspace" value={workspaceName} />
                </PullDown>
              ) : null}
              <PullDown
                label="When"
                title="When"
                sections={[{ items: EVENTS.map((item) => ({ id: item.id, title: item.title, checked: item.id === form.linear.event })) }]}
                onSelect={(event) => changeLinear({ event: event as RoutineLinearEvent })}
              >
                <FormRow icon={FlashIcon} label="When" value={EVENTS.find((item) => item.id === form.linear.event)?.title ?? ""} />
              </PullDown>
              {form.linear.event === "label-added" ? (
                <PullDown
                  label="Label"
                  title="Label"
                  searchable={{ placeholder: "Search labels", emptyLabel: "No matching labels" }}
                  nativeTrigger={shows(form.linear.label || "Choose")}
                  sections={[{ items: (linearOptions?.labels ?? []).map((label) => ({ id: label, title: label, checked: label === form.linear.label })) }]}
                  onSelect={(label) => changeLinear({ label })}
                >
                  <FormRow icon={Tag01Icon} label="Label" value={form.linear.label || "Choose"} />
                </PullDown>
              ) : null}
              {form.linear.event === "state" ? (
                <PullDown
                  label="State"
                  title="State"
                  searchable={{ placeholder: "Search states", emptyLabel: "No matching states" }}
                  nativeTrigger={shows(form.linear.state || "Choose")}
                  sections={[
                    { items: (linearOptions?.states ?? []).map((item) => ({ id: item.name, title: item.name, checked: item.name === form.linear.state })) },
                  ]}
                  onSelect={(state) => changeLinear({ state })}
                >
                  <FormRow icon={Exchange01Icon} label="State" value={form.linear.state || "Choose"} />
                </PullDown>
              ) : null}
              <PullDown
                label="Team"
                title="Team"
                searchable={{ placeholder: "Search teams", emptyLabel: "No matching teams" }}
                nativeTrigger={shows(teamText)}
                sections={[
                  {
                    items: [
                      { id: ANY_TEAM, title: "Any team", checked: !form.linear.team },
                      ...(linearOptions?.teams ?? []).map((item) => ({
                        id: item.key,
                        title: `${item.key} · ${item.name}`,
                        checked: item.key === form.linear.team,
                      })),
                    ],
                  },
                ]}
                onSelect={(key) => changeLinear({ team: key === ANY_TEAM ? "" : key, label: "", state: "" })}
              >
                <FormRow icon={UserMultipleIcon} label="Team" value={teamText} />
              </PullDown>
            </Card>
          ) : null}

          {form.trigger === "webhook" ? (
            <Card>
              <FormRow icon={WebhookIcon} label="URL" value={url ? "" : "After you create it"} />
              {url ? (
                <View style={{ gap: 10, paddingBottom: 14 }}>
                  <Text selectable numberOfLines={2} style={[styles.code, { color: colors.ink2 }]}>
                    {url}
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <PillButton title="Copy" icon={Copy01Icon} secondary onPress={() => void Clipboard.setStringAsync(url)} style={{ flex: 1, height: 40 }} />
                    <PillButton title="Rotate" icon={Refresh01Icon} secondary onPress={() => void rotate()} style={{ flex: 1, height: 40 }} />
                  </View>
                </View>
              ) : null}
              <FormRow icon={Shield01Icon} label="Check signature">
                <RowCheckbox
                  label="Check signature"
                  selected={signed}
                  onPress={() => change({ webhook: signed ? { signed: false, signingHeader: "", signingSecret: "" } : { ...form.webhook, signed: true } })}
                />
              </FormRow>
              {signed ? (
                <FormRow icon={Shield01Icon} label="Signing header">
                  <Field
                    label="Signing header"
                    hideLabel
                    placeholder="sentry-hook-signature"
                    value={form.webhook.signingHeader}
                    onChangeText={(signingHeader) => change({ webhook: { ...form.webhook, signingHeader } })}
                    style={inlineField(colors)}
                  />
                </FormRow>
              ) : null}
              {signed ? (
                <FormRow icon={Shield01Icon} label="Signing secret">
                  <Field
                    label="Signing secret"
                    hideLabel
                    secureTextEntry
                    // A stored secret never comes back; a new one replaces it.
                    placeholder={routine?.trigger.kind === "webhook" && routine.trigger.signed ? "Saved" : "Required"}
                    value={form.webhook.signingSecret}
                    onChangeText={(signingSecret) => change({ webhook: { ...form.webhook, signingSecret } })}
                    style={inlineField(colors)}
                  />
                </FormRow>
              ) : null}
            </Card>
          ) : null}
          <Problem text={problemFor("trigger", "schedule", "timezone", "workspace", "label", "state", "signingSecret")} />

          {commentRoutine ? <Text style={[styles.caption, { paddingHorizontal: 4 }]}>Comments go into the Chat linked to the issue.</Text> : null}
          <Card>
            {commentRoutine ? null : (
              <PullDown
                label="Project"
                title="Project"
                searchable={{ placeholder: "Search Projects", emptyLabel: "No matching Projects" }}
                nativeTrigger={shows(project?.name ?? "Choose", heartbeat && editing)}
                sections={[{ items: projects.map((item) => ({ id: item.path, title: item.name, subtitle: item.path, checked: item.path === project?.path })) }]}
                onSelect={(projectPath) => change({ projectPath, chatId: "" })}
              >
                <FormRow icon={Folder01Icon} label="Project" value={project?.name ?? "Choose"} />
              </PullDown>
            )}
            {commentRoutine ? null : (
              <PullDown
                label="Works in"
                title="Each Run works in"
                sections={[
                  {
                    items: RUN_IN.map((item) => ({
                      id: item.id,
                      title: item.title,
                      checked: item.id === form.runIn,
                      // Only a schedule checks back on a Chat; an edit can't move Runs between a Chat and new Chats.
                      disabled: (item.id === "chat" && form.trigger !== "schedule") || (editing && (item.id === "chat") !== heartbeat),
                    })),
                  },
                ]}
                onSelect={(runIn) => {
                  setDirty(true);
                  setProblem(null);
                  setForm((current) => withRunIn(current, runIn as RoutineFormState["runIn"], Date.now()));
                }}
              >
                <FormRow icon={GitBranchIcon} label="Works in" value={RUN_IN.find((item) => item.id === form.runIn)?.title ?? ""} />
              </PullDown>
            )}
            {heartbeat ? (
              <PullDown
                label="Chat"
                title="Chat"
                searchable={{ placeholder: "Search Chats", emptyLabel: project ? "No Chats in this Project" : "Choose a Project first" }}
                nativeTrigger={shows(chat?.title ?? "Choose")}
                sections={[{ items: (project?.chats ?? []).map((item) => ({ id: item.chatId, title: item.title, checked: item.chatId === form.chatId })) }]}
                onSelect={(chatId) => change({ chatId })}
              >
                <FormRow icon={BubbleChatIcon} label="Chat" value={chat?.title ?? "Choose"} />
              </PullDown>
            ) : null}
            <PullDown
              label="Model"
              title="Model"
              searchable={{ placeholder: "Search models", emptyLabel: "No matching models" }}
              nativeTrigger={shows(model?.name ?? (form.model || "Default"))}
              sections={[
                {
                  items: [
                    { id: DEFAULT, title: "Default", subtitle: "The Mac's default model", checked: !form.model },
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
                if (choice === DEFAULT) change({ provider: "", model: "" });
                else {
                  const split = choice.indexOf(":");
                  change({ provider: choice.slice(0, split) as ModelProvider, model: choice.slice(split + 1) });
                }
              }}
            >
              <FormRow icon={SparklesIcon} label="Model" value={model?.name ?? (form.model || "Default")} />
            </PullDown>
            {fallbackApplies(form) ? (
              <PullDown
                label="Fallback"
                title="Retry on"
                searchable={{ placeholder: "Search models", emptyLabel: "No matching models" }}
                nativeTrigger={shows(fallbackName)}
                sections={[
                  {
                    items: [
                      {
                        id: DEFAULT,
                        title: "Another provider",
                        subtitle: "When a Run fails on its model, it retries once on another installed provider",
                        checked: !form.fallbackModel,
                      },
                      ...models.map((item) => ({
                        id: `${item.provider}:${item.id}`,
                        title: item.name,
                        subtitle: providerName(item.provider),
                        checked: item === fallbackModel,
                      })),
                    ],
                  },
                ]}
                onSelect={(choice) => {
                  if (choice === DEFAULT) change({ fallbackProvider: "", fallbackModel: "", fallbackEffort: "" });
                  else {
                    const split = choice.indexOf(":");
                    const provider = choice.slice(0, split) as ModelProvider;
                    const modelId = choice.slice(split + 1);
                    const efforts = models.find((item) => item.provider === provider && item.id === modelId)?.efforts ?? [];
                    // Another model drops an effort it doesn't take.
                    change({
                      fallbackProvider: provider,
                      fallbackModel: modelId,
                      fallbackEffort: efforts.includes(form.fallbackEffort) ? form.fallbackEffort : "",
                    });
                  }
                }}
              >
                <FormRow icon={Refresh01Icon} label="Fallback" value={fallbackName} />
              </PullDown>
            ) : null}
            {fallbackApplies(form) && form.fallbackModel && (fallbackEfforts.length > 0 || form.fallbackEffort) ? (
              <PullDown
                label="Fallback effort"
                title="Fallback effort"
                sections={[
                  {
                    items: [
                      { id: DEFAULT, title: "Default", subtitle: "The model's own default", checked: !form.fallbackEffort },
                      ...fallbackEfforts.map((effort) => ({ id: effort, title: effortName(effort), checked: effort === form.fallbackEffort })),
                    ],
                  },
                ]}
                onSelect={(choice) => change({ fallbackEffort: choice === DEFAULT ? "" : choice })}
              >
                <FormRow icon={Refresh01Icon} label="Fallback effort" value={form.fallbackEffort ? effortName(form.fallbackEffort) : "Default"} />
              </PullDown>
            ) : null}
            <PullDown
              label="Mode"
              title="Permissions"
              sections={[
                {
                  items: [
                    { id: DEFAULT, title: "Default", checked: !form.permissionMode },
                    ...PERMISSION_MODES.map((item) => ({
                      id: item.id,
                      title: item.name,
                      subtitle: item.description,
                      checked: item.id === form.permissionMode,
                    })),
                  ],
                },
              ]}
              onSelect={(choice) => change({ permissionMode: choice === DEFAULT ? "" : choice })}
            >
              <FormRow icon={Shield01Icon} label="Mode" value={mode?.name ?? "Default"} />
            </PullDown>
          </Card>
          <Problem text={problemFor("project", "runIn", "chat")} />

          <Text style={[styles.label, { paddingHorizontal: 4, marginTop: 4 }]}>Prompt</Text>
          <PlaceholderField value={form.prompt} onChangeText={(prompt) => change({ prompt })} placeholders={placeholders} placeholder={PROMPT_PLACEHOLDER} />
          <Text style={[styles.caption, { paddingHorizontal: 4 }]}>{promptHint(form.trigger)}</Text>
          <Problem text={problemFor("prompt")} />

          <Text style={[styles.label, { paddingHorizontal: 4, marginTop: 4 }]}>Stop after</Text>
          <Card>
            <PullDown
              label="Stop after"
              title="Stop after"
              sections={[
                {
                  items: [
                    // A Heartbeat always ends.
                    { id: "never", title: "Never", checked: form.stop.kind === "never", disabled: heartbeat },
                    { id: "runs", title: "A number of Runs", checked: form.stop.kind === "runs" },
                    { id: "date", title: "A date", checked: form.stop.kind === "date" },
                  ],
                },
              ]}
              onSelect={(kind) => change({ stop: { ...form.stop, kind: kind as RoutineFormState["stop"]["kind"] } })}
            >
              <FormRow
                icon={Flag02Icon}
                label="Stop after"
                value={
                  form.stop.kind === "never"
                    ? "Never"
                    : form.stop.kind === "runs"
                      ? form.stop.runs === 1
                        ? "1 Run"
                        : `${form.stop.runs} Runs`
                      : `Ends ${dateText(form.stop.at)}`
                }
              />
            </PullDown>
            {form.stop.kind === "runs" ? (
              <FormRow icon={RepeatIcon} label="Runs">
                <Field
                  label="Runs"
                  hideLabel
                  keyboardType="number-pad"
                  value={String(form.stop.runs || "")}
                  onChangeText={(text) => change({ stop: { ...form.stop, runs: Number(text.replace(/\D/g, "")) || 0 } })}
                  style={inlineField(colors)}
                />
              </FormRow>
            ) : null}
            {form.stop.kind === "date" ? (
              <PullDown
                label="Ends"
                title="Ends"
                sections={[{ items: ENDS_IN.map((days) => ({ id: String(days), title: days === 1 ? "In 1 day" : `In ${days} days` })) }]}
                onSelect={(days) => change({ stop: { ...form.stop, at: Date.now() + Number(days) * DAY_MS } })}
              >
                <FormRow icon={Calendar01Icon} label="Ends" value={dateText(form.stop.at)} />
              </PullDown>
            ) : null}
          </Card>
          <Problem text={problemFor("stop")} />

          {routine && !createdId ? (
            <View style={[styles.card, { gap: 10, marginTop: 12 }]}>
              <Text style={[styles.caption, { fontSize: 13, color: colors.ink2 }]}>{deleteWarning(routine)}</Text>
              <Button title="Delete Routine" secondary destructive onPress={() => void remove()} />
            </View>
          ) : null}
        </View>
      </PageScroll>
      <View
        onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.line,
          backgroundColor: colors.page,
          padding: 20,
          paddingBottom: Math.max(insets.bottom, 20),
        }}
      >
        <PillButton
          title={editing ? "Save" : "Create Routine"}
          icon={editing ? undefined : Add01Icon}
          loading={saving}
          disabled={!client || !!routines.unavailable || (!editing && (!form.name.trim() || !form.prompt.trim()))}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}

/** The Project a Chat key belongs to: the part before its `#`. */
function chatProject(chatId: string, projects: Targets["projects"]) {
  return projects.find((item) => item.chats.some((chat) => chat.chatId === chatId))?.path ?? chatId.slice(0, chatId.lastIndexOf("#"));
}

const inlineField = (colors: ReturnType<typeof useTheme>["colors"]) =>
  ({ backgroundColor: "transparent", color: colors.ink2, textAlign: "right", paddingHorizontal: 0, minWidth: 120, fontSize: 15 }) as const;

/** A card of rows split by hairlines. */
function Card({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
      {Children.toArray(children).map((child, index) => (
        <View key={(child as { key?: string }).key ?? String(index)}>
          {index > 0 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line }} /> : null}
          {child}
        </View>
      ))}
    </View>
  );
}

/** One setting: its icon and name, then its value and a chevron, or an inline input in place of both. */
function FormRow({
  icon,
  label,
  value,
  readOnly = false,
  children,
}: {
  icon: IconData;
  label: string;
  value?: string;
  /** Shown, not chosen: no chevron. */
  readOnly?: boolean;
  children?: React.ReactNode;
}) {
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
          {readOnly ? null : <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />}
        </>
      )}
    </View>
  );
}

/** A field's problem, under the card it belongs to. */
function Problem({ text }: { text: string }) {
  const { colors } = useTheme();
  if (!text) return null;
  return (
    <Text accessibilityRole="alert" style={{ color: colors.error, fontSize: 13, paddingHorizontal: 4 }}>
      {text}
    </Text>
  );
}
