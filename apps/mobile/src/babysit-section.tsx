import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Add01Icon, ArrowRight01Icon, File01Icon, Message01Icon, Tick02Icon, Upload01Icon, UserCheck01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { BABYSIT_DEFAULTS, BABYSIT_LEVELS, DAYS_OPTIONS, FAILURE_OPTIONS, INTERVAL_OPTIONS, type BabysitStep, type BabysitWake } from "@milagre/shared/babysit";
import { babysitHost, babysitSettingsStore, createDebouncedSave, type BabysitChange, type BabysitState, type SaveState } from "./babysit-settings";
import { Icon, type IconData } from "./icons";
import { useSession } from "./session";
import { Group, Row } from "./settings-list";
import { useTheme } from "./theme";
import { ErrorNotice, Segmented, Toggle, useStyles } from "./ui";

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
const dimmed = (on: boolean) => (on ? null : { opacity: 0.4 });
const DAYS = options(DAYS_OPTIONS, (value) => plural(value, "day", "days"));
const FAILURES = options(FAILURE_OPTIONS, (value) => plural(value, "time", "times"));

/** A typed field that saves itself shortly after typing stops and when it loses focus or the screen closes. */
function useAutosave(saved: string, key: "instructions" | "ownRuleText", save: Save) {
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
  const ownRule = useAutosave(state.settings?.ownRuleText ?? "", "ownRuleText", save);
  const instructions = useAutosave(state.settings?.instructions ?? "", "instructions", save);
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
      <Text accessibilityRole="alert" style={[styles.caption, { color: colors.red }]}>
        Not saved
      </Text>
    ) : mark === "saving" ? (
      <Text style={styles.caption}>Saving…</Text>
    ) : mark === "saved" ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Icon icon={Tick02Icon} tone="ink3" size={12} />
        <Text style={styles.caption}>Saved</Text>
      </View>
    ) : null;
  const toggle = (title: string, selected: boolean, onPress: () => void, disabled = false) => (
    <Toggle title={title} selected={selected} disabled={disabled} tint={colors.accent} onPress={onPress} />
  );
  return (
    <View style={{ gap: 20 }}>
      {error}
      <Group title="Babysit PRs">
        <View style={{ gap: 4, paddingVertical: 8 }}>
          {toggle("Babysit new PRs", settings.enabled, () => change({ enabled: !settings.enabled }))}
          {caption("Off by default. When a Chat opens a PR, Milagre adds a Heartbeat to that Chat and watches the PR until it's done.")}
        </View>
        <View style={{ gap: 8, paddingVertical: 12 }}>
          <Text style={{ color: colors.ink, fontSize: 17 }}>Check every</Text>
          <Segmented
            label="Check every"
            value={String(settings.intervalMinutes)}
            options={INTERVALS}
            onChange={(value) => change({ intervalMinutes: Number(value) })}
          />
          {caption("Milagre asks GitHub itself on this interval. The agent only wakes when something new shows up, so idle PRs cost nothing.")}
        </View>
        <View style={{ gap: 10, paddingVertical: 12 }}>
          <Text style={{ color: colors.ink, fontSize: 17 }}>Wake the agent for</Text>
          <View accessibilityLabel="Wake the agent for" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {WAKE.map(({ kind, label }) => {
              const on = settings.wake.includes(kind);
              return (
                <Pressable
                  key={kind}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: on }}
                  onPress={() => toggleWake(kind)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    height: 34,
                    paddingHorizontal: 12,
                    borderRadius: 17,
                    borderWidth: 1,
                    borderColor: on ? colors.accentTint : colors.line,
                    backgroundColor: on ? colors.accentTint : "transparent",
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Icon icon={on ? Tick02Icon : Add01Icon} tone={on ? "accentInk" : "ink2"} size={14} />
                  <Text style={{ color: on ? colors.accentInk : colors.ink2, fontSize: 14, fontWeight: "500" }}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </Group>
      <Group title="When something needs fixing">
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
                style={({ pressed }) => ({
                  flexDirection: "row",
                  gap: 10,
                  padding: 12,
                  borderRadius: 14,
                  borderCurve: "continuous",
                  borderWidth: selected ? 2 : 1,
                  borderColor: selected ? colors.accent : colors.line,
                  backgroundColor: selected ? colors.accentTint : "transparent",
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                {selected ? (
                  <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent }}>
                    <Icon icon={Tick02Icon} tone="onAccent" size={12} />
                  </View>
                ) : (
                  <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colors.ink3 }} />
                )}
                <View style={{ flex: 1, gap: 6 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Text style={{ flexShrink: 1, color: selected ? colors.accentInk : colors.ink, fontSize: 15, fontWeight: "600" }}>{entry.title}</Text>
                    {entry.level === BABYSIT_DEFAULTS.level ? (
                      <Text
                        style={{
                          color: colors.ink2,
                          fontSize: 11,
                          fontWeight: "500",
                          backgroundColor: colors.field,
                          borderRadius: 4,
                          paddingHorizontal: 6,
                          overflow: "hidden",
                        }}
                      >
                        Default
                      </Text>
                    ) : null}
                  </View>
                  <Text style={{ color: selected ? colors.accentInk : colors.ink3, fontSize: 13, lineHeight: 18 }}>{entry.description}</Text>
                  <View
                    accessibilityLabel={entry.steps.map((step) => STEPS[step].name).join(", then ")}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      alignSelf: "flex-start",
                      gap: 3,
                      height: 24,
                      paddingHorizontal: 8,
                      borderRadius: 12,
                      backgroundColor: selected ? colors.surface : colors.field,
                    }}
                  >
                    {entry.steps.map((step, index) => (
                      <View key={step} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                        {index > 0 ? <Icon icon={ArrowRight01Icon} tone="ink3" size={10} /> : null}
                        <Icon icon={STEPS[step].icon} tone={selected ? "accent" : "ink2"} size={13} />
                      </View>
                    ))}
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
        <View style={{ gap: 4, paddingVertical: 8 }}>
          {toggle("Resolve threads it answered", settings.resolveThreads, () => change({ resolveThreads: !settings.resolveThreads }))}
          {caption("On by default. After replying on a thread, the agent marks it resolved.")}
        </View>
      </Group>
      <Group title="Stop babysitting when">
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
      <Group title="Your instructions">
        {[
          <View key="instructions" style={{ gap: 6, paddingVertical: 12 }}>
            <TextInput
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
          </View>,
        ]}
      </Group>
      <View style={[styles.card, { paddingVertical: 0 }]}>
        <Row title="Reset all to defaults" chevron={false} onPress={() => change(BABYSIT_DEFAULTS)} />
      </View>
    </View>
  );
}
