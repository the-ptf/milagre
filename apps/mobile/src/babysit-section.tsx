import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Pressable, Text, TextInput, View, type TextInputInstance } from "react-native";
import { lineHeight, radius, space, type } from "./design-tokens";
import { useFocusEffect } from "expo-router";
import { Add01Icon, ArrowRight01Icon, File01Icon, Message01Icon, Tick02Icon, Upload01Icon, UserCheck01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { BABYSIT_DEFAULTS, BABYSIT_LEVELS, DAYS_OPTIONS, FAILURE_OPTIONS, INTERVAL_OPTIONS, type BabysitStep, type BabysitWake } from "@milagre/shared/babysit";
import { babysitHost, babysitSettingsStore, createDebouncedSave, type BabysitChange, type BabysitState, type SaveState } from "./babysit-settings";
import { Icon, type IconData } from "./icons";
import { useSession } from "./session";
import { Group, Row } from "./settings-list";
import { useTheme } from "./theme";
import { Chip, DISABLED_OPACITY, ErrorNotice, InlineError, pressStyle, Segmented, Tag, Toggle, useStyles } from "./ui";

type Save = (change: BabysitChange) => Promise<void>;

const WAKE: { kind: BabysitWake; label: string }[] = [
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
const options = (values: readonly number[], title: (value: number) => string) => values.map((value) => ({ value: String(value), title: title(value) }));
// Six segments share a phone's width, so the interval reads "5 min" where desktop's menu says "5 minutes".
const INTERVALS = options(INTERVAL_OPTIONS, (value) => `${value} min`);
// An off rule keeps its number, shown dimmed, so turning it back on restores it.
const dimmed = (on: boolean) => (on ? null : { opacity: DISABLED_OPACITY.control });
const DAYS = options(DAYS_OPTIONS, (value) => plural(value, "day", "days"));
const FAILURES = options(FAILURE_OPTIONS, (value) => plural(value, "time", "times"));

/**
 * A typed field that saves itself shortly after typing stops and when it loses focus or the screen closes. `reset` (Reset
 * all to defaults) drops what was typed, leaves the field and shows the default.
 */
function useAutosave(saved: string, key: "instructions" | "ownRuleText", save: Save, input: RefObject<TextInputInstance | null>) {
  const [value, setValue] = useState(saved);
  // Text the Mac already holds counts as saved until it is edited.
  const [state, setState] = useState<SaveState>(saved ? "saved" : "idle");
  const focused = useRef(false);
  // Typed but not yet saved: a value from the Mac does not replace it (a failed save keeps the text).
  const dirty = useRef(false);
  // One saver per Mac: a reconnect flushes the old one (the cleanup below) and starts a new one.
  const saver = useMemo(() => createDebouncedSave(save, 500, setState), [save]);
  useEffect(() => {
    if (state === "saved") dirty.current = false;
  }, [state]);
  useEffect(() => {
    if (focused.current || dirty.current) return;
    setValue(saved);
    setState((current) => (current === "saving" ? current : saved ? "saved" : "idle"));
  }, [saved]);
  // Leaving the screen saves what was typed last.
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
    onChangeText: (next: string) => {
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

/**
 * Settings › Experimental › Babysit PRs: the one configuration every Chat's babysitting follows, kept by the connected
 * Mac (desktop's BabysitPrsSettings). Re-read on focus: it may have changed on the Mac while the phone was elsewhere.
 */
export function BabysitSection() {
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSession();
  const [state, setState] = useState<BabysitState>({ settings: null, error: "", unsupported: false });
  const client = session.client;
  const host = useMemo(() => (client ? babysitHost(client) : null), [client]);
  const [store] = useState(() => babysitSettingsStore(setState));
  useFocusEffect(
    useCallback(() => {
      if (host) void store.read(host);
    }, [store, host]),
  );
  const save = useCallback<Save>((change) => (host ? store.save(host, change) : Promise.resolve()), [store, host]);
  const ownRuleInput = useRef<TextInputInstance>(null);
  const instructionsInput = useRef<TextInputInstance>(null);
  const ownRule = useAutosave(state.settings?.ownRuleText ?? "", "ownRuleText", save, ownRuleInput);
  const instructions = useAutosave(state.settings?.instructions ?? "", "instructions", save, instructionsInput);
  const settings = state.settings;
  if (!client) return <Text style={styles.muted}>Connect to a Mac to change Babysit PRs.</Text>;
  if (state.unsupported) return <Text style={styles.muted}>Update Milagre on your Mac to use Babysit PRs.</Text>;
  const error = state.error ? <ErrorNotice message={state.error} /> : null;
  if (!settings) return error;
  // Switches, choices and chips save at once; a failure shows in the error above the groups.
  // Values that build on the current ones (chips, number rules) are worked out from the latest settings, changes still on their way included.
  const change = (patch: BabysitChange) => void save(patch).catch(() => {});
  const toggleWake = (kind: BabysitWake) =>
    change((current) => {
      const on = current.wake.includes(kind) ? current.wake.filter((item) => item !== kind) : [...current.wake, kind];
      return { wake: WAKE.map((item) => item.kind).filter((item) => on.includes(item)) };
    });
  const caption = (text: string) => <Text style={styles.caption}>{text}</Text>;
  const saveMark = (mark: SaveState) =>
    mark === "error" ? (
      <InlineError message="Not saved" />
    ) : mark === "saving" ? (
      <Text style={styles.caption}>Saving…</Text>
    ) : mark === "saved" ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Icon icon={Tick02Icon} tone="ink3" size={12} />
        <Text style={styles.caption}>Saved</Text>
      </View>
    ) : null;
  const toggle = (title: string, selected: boolean, onPress: () => void, disabled = false) => (
    <Toggle title={title} selected={selected} disabled={disabled} onPress={onPress} />
  );
  const reset = () => {
    ownRule.reset();
    instructions.reset();
    change(BABYSIT_DEFAULTS);
  };
  return (
    <View style={{ gap: space.section }}>
      {error}
      <Group title="Babysit PRs" inset={0}>
        <View style={{ gap: 4, paddingVertical: 8 }}>
          {toggle("Babysit new PRs", settings.enabled, () => change({ enabled: !settings.enabled }))}
          {caption("Off by default. When a Chat opens a PR, Milagre adds a Heartbeat to that Chat and watches the PR until it's done.")}
        </View>
        <View style={{ gap: 8, paddingVertical: 12 }}>
          <Text style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body }}>Check every</Text>
          <Segmented
            label="Check every"
            value={String(settings.intervalMinutes)}
            options={INTERVALS}
            onChange={(value) => change({ intervalMinutes: Number(value) })}
          />
          {caption("Milagre asks GitHub itself on this interval. The agent only wakes when something new shows up, so idle PRs cost nothing.")}
        </View>
        <View style={{ gap: space.lg, paddingVertical: space.lg }}>
          <Text style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body }}>Wake the agent for</Text>
          <View accessibilityLabel="Wake the agent for" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {WAKE.map(({ kind, label }) => {
              const on = settings.wake.includes(kind);
              return (
                <Chip
                  key={kind}
                  label={label}
                  selected={on}
                  multiple
                  leading={<Icon icon={on ? Tick02Icon : Add01Icon} tone={on ? "onInk" : "ink2"} size={12} />}
                  onPress={() => toggleWake(kind)}
                />
              );
            })}
          </View>
        </View>
      </Group>
      <Group title="When something needs fixing" inset={0} footer="Each PR keeps the settings it started with: changes here apply to PRs opened afterwards.">
        <View accessibilityRole="radiogroup" accessibilityLabel="When something needs fixing" style={{ gap: 8, paddingVertical: 12 }}>
          {BABYSIT_LEVELS.map((entry) => {
            const selected = entry.level === settings.level;
            return (
              <Pressable
                key={entry.level}
                accessibilityRole="radio"
                accessibilityLabel={`${entry.title}. ${entry.description}`}
                accessibilityState={{ checked: selected }}
                onPress={() => {
                  if (!selected) change({ level: entry.level });
                }}
                style={({ pressed }) => [
                  {
                    flexDirection: "row",
                    gap: space.lg,
                    borderRadius: radius.card,
                    borderCurve: "continuous",
                    // The 2pt ink edge marks the choice; padding gives back the extra point so the card doesn't move.
                    borderWidth: selected ? 2 : 1,
                    borderColor: selected ? colors.ink : colors.lineStrong,
                    padding: selected ? space.lg - 1 : space.lg,
                  },
                  pressStyle({ pressed }),
                ]}
              >
                <View style={{ flex: 1, gap: 6 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Text
                      style={{
                        flexShrink: 1,
                        color: colors.ink,
                        fontSize: type.subheadline,
                        lineHeight: lineHeight.subheadline,
                        fontWeight: "600",
                      }}
                    >
                      {entry.title}
                    </Text>
                    {entry.level === BABYSIT_DEFAULTS.level ? <Tag label="Default" /> : null}
                  </View>
                  <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{entry.description}</Text>
                  <View
                    accessibilityLabel={entry.steps.map((step) => STEPS[step].name).join(", then ")}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      alignSelf: "flex-start",
                      gap: space.xs,
                      height: 24,
                      paddingHorizontal: space.md,
                      borderRadius: radius.full,
                      backgroundColor: colors.field,
                    }}
                  >
                    {entry.steps.map((step, index) => (
                      <View key={step} style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                        {index > 0 ? <Icon icon={ArrowRight01Icon} tone="ink3" size={12} /> : null}
                        <Icon icon={STEPS[step].icon} tone="ink2" size={12} />
                      </View>
                    ))}
                  </View>
                </View>
                {/* CheckRow's tick, at the end. */}
                {selected && <Icon icon={Tick02Icon} tone="ink" size={18} />}
              </Pressable>
            );
          })}
        </View>
        <View style={{ gap: 4, paddingVertical: 8 }}>
          {toggle("Resolve threads it answered", settings.resolveThreads, () => change({ resolveThreads: !settings.resolveThreads }))}
          {caption("On by default. After replying on a thread, the agent marks it resolved.")}
        </View>
      </Group>
      <Group title="Stop babysitting when" inset={0}>
        <View style={{ gap: 4, paddingVertical: 8 }}>
          {toggle("The PR is merged or closed", true, () => {}, true)}
          {caption("Always")}
        </View>
        <View style={{ gap: 4, paddingVertical: 8 }}>
          {toggle("Checks pass and the PR is approved", settings.stopWhenGreen, () => change({ stopWhenGreen: !settings.stopWhenGreen }))}
          {caption("Nothing left to address. A comment that lands after this goes unwatched.")}
        </View>
        <View style={{ gap: 8, paddingVertical: 8 }}>
          {toggle("It has watched the PR for", settings.stopAfterDays.on, () =>
            change((current) => ({ stopAfterDays: { ...current.stopAfterDays, on: !current.stopAfterDays.on } })),
          )}
          <View pointerEvents={settings.stopAfterDays.on ? "auto" : "none"} style={dimmed(settings.stopAfterDays.on)}>
            <Segmented
              label="Watch the PR for"
              value={String(settings.stopAfterDays.days)}
              options={DAYS}
              onChange={(value) => change((current) => ({ stopAfterDays: { ...current.stopAfterDays, days: Number(value) } }))}
            />
          </View>
        </View>
        <View style={{ gap: 8, paddingVertical: 8 }}>
          {toggle("It failed to fix the same problem", settings.stopAfterFailures.on, () =>
            change((current) => ({ stopAfterFailures: { ...current.stopAfterFailures, on: !current.stopAfterFailures.on } })),
          )}
          <View pointerEvents={settings.stopAfterFailures.on ? "auto" : "none"} style={dimmed(settings.stopAfterFailures.on)}>
            <Segmented
              label="Failed to fix the same problem"
              value={String(settings.stopAfterFailures.times)}
              options={FAILURES}
              onChange={(value) => change((current) => ({ stopAfterFailures: { ...current.stopAfterFailures, times: Number(value) } }))}
            />
          </View>
        </View>
        <View style={{ gap: 4, paddingVertical: 8 }}>
          {toggle("Your own rule", settings.ownRule, () => change({ ownRule: !settings.ownRule }))}
          {caption("The agent checks it each time it wakes and ends the Heartbeat when it holds.")}
          {settings.ownRule ? (
            <View style={{ gap: 4, paddingTop: 6 }}>
              <TextInput
                ref={ownRuleInput}
                accessibilityLabel="Your own rule"
                maxLength={300}
                value={ownRule.value}
                onChangeText={ownRule.onChangeText}
                onFocus={ownRule.onFocus}
                onBlur={ownRule.onBlur}
                placeholderTextColor={colors.ink3}
                selectionColor={colors.accent}
                style={styles.input}
              />
              {ownRule.state === "error" ? saveMark("error") : null}
            </View>
          ) : null}
        </View>
      </Group>
      <Group title="Your instructions" inset={0}>
        <View style={{ gap: 6, paddingVertical: 12 }}>
          <TextInput
            ref={instructionsInput}
            accessibilityLabel="Your instructions"
            multiline
            maxLength={4000}
            value={instructions.value}
            onChangeText={instructions.onChangeText}
            onFocus={instructions.onFocus}
            onBlur={instructions.onBlur}
            selectionColor={colors.accent}
            style={[styles.input, { minHeight: 120, textAlignVertical: "top" }]}
          />
          <View style={{ minHeight: 16, alignItems: "flex-end" }}>{saveMark(instructions.state)}</View>
        </View>
      </Group>
      <View style={[styles.card, { paddingVertical: 0 }]}>
        <Row title="Reset all to defaults" chevron={false} onPress={reset} />
      </View>
    </View>
  );
}
