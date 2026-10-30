import { pickerProviders, providerName } from "@milagre/shared/providers";
import { contextWindowFor, effortFor } from "@milagre/shared/model-options";
import { formatTokens } from "@milagre/shared/usage";
import { formatCredits } from "@milagre/shared/kiro-models";
import { effortCopy } from "@milagre/shared/model-copy";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { Cancel01Icon, FlashIcon, Tick02Icon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import type { ModelProvider } from "@milagre/shared/model";
import { useComposer, useSession } from "../session";
import { modelsFor, selectedModel, afterSheet, type TurnPreferences } from "../turn-options";
import { Icon, ProviderLogo } from "../icons";
import { EffortSlider } from "../effort-slider";
import { UltracodeFatality } from "../ultracode-fatality";
import { ultraRumble } from "../ultra-haptics";
import { useUltracodeFatality } from "../ultracode-fatality-setting";
import { CircleButton, useStyles } from "../ui";
import { useTheme } from "../theme";

/** The model's context window as the picker shows it: "1M", "272k". */
function contextLabel(model: { provider: ModelProvider; id: string }) {
  const size = contextWindowFor(model);
  return size ? formatTokens(size) : undefined;
}

/** A Kiro model's credit multiplier ("2×") and how a screen reader says it, else its context window. */
function metaOf(model: { provider: ModelProvider; id: string; credits?: number }) {
  if (model.credits) return { label: formatCredits(model.credits), spoken: `${formatCredits(model.credits)} the credits Auto would use` };
  const label = contextLabel(model);
  return label ? { label, spoken: `${label} context window` } : null;
}

/** Model, thinking effort, fast mode and Ultracode for one Chat: provider chips that scroll sideways as providers grow,
 * the provider's models, and the settings pinned below them. Cancel (✕) discards, Done (✓) applies, per Apple's sheet guidance. */
export default function ModelSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const params = useLocalSearchParams<{ chatId: string; model?: string; provider?: string; on?: string; busy?: string }>();
  const session = useSession();
  const composer = useComposer();
  const saved = composer.preferences[params.chatId] || composer.defaults;
  const initial: TurnPreferences = { ...saved, provider: (params.provider as ModelProvider | undefined) || saved.provider, model: params.model || saved.model };
  const [draft, setDraft] = useState<TurnPreferences>(initial);
  const busy = params.busy === "1";
  const model = selectedModel(draft.provider, draft.model, session.models);
  const models = modelsFor(draft.provider, session.models);
  if (!models.some((item) => item.id === model.id)) models.unshift(model);
  const effort = effortFor(model, draft.effort);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const [closing, setClosing] = useState(false);
  // Bumped each time Ultracode turns on; the Fatality overlay plays once per bump (Settings › Experimental).
  const [fatality, setFatality] = useState(0);
  // The settings panel floats over the bottom of the models list (the sheet stretches its ScrollView to the full
  // sheet), so the list pads its end by the panel's height and every model can scroll above it.
  const [panelHeight, setPanelHeight] = useState(0);
  const hasSettings = model.efforts.length > 0 || model.fastMode || model.ultracode;
  const [fatalityOn] = useUltracodeFatality();
  usePreventRemove(dirty && !closing, ({ repeat }) =>
    Alert.alert("Discard changes?", "Your model and effort picks will not be applied.", [
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
  const close = (apply: boolean) => {
    if (apply) {
      if (/#new:/.test(params.chatId)) composer.setDefaultModel({ ...draft, model: model.id });
      composer.setPreferences((current) => ({
        ...current,
        [params.chatId]: afterSheet({ ...draft, model: model.id }, (params.on as ModelProvider | undefined) || undefined),
      }));
    }
    setClosing(true);
    setTimeout(() => router.back(), 0);
  };
  const cli = session.cliStatus?.[draft.provider];
  const levels = model.efforts;
  const level = Math.max(0, levels.indexOf(effort ?? ""));
  return (
    // Not collapsable: a form sheet lays out a ScrollView with at most one header beside it, and a flattened root would
    // hand it every row below (RNScreens warns "expects at most 2 subviews") and misplace the list.
    <View collapsable={false} style={styles.screen}>
      {/* The header and provider chips ride inside the models scroller as one pinned block. */}
      <ScrollView
        style={{ flex: 1 }}
        stickyHeaderIndices={[0]}
        contentContainerStyle={{ paddingBottom: 16 + (hasSettings ? panelHeight : 0) }}
        scrollIndicatorInsets={{ bottom: hasSettings ? panelHeight : 0 }}
      >
        <View style={{ backgroundColor: colors.page }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 8,
              backgroundColor: colors.page,
            }}
          >
            <CircleButton label="Cancel" icon={Cancel01Icon} onPress={() => close(false)} />
            <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
              Model
            </Text>
            <CircleButton label="Done" icon={Tick02Icon} filled onPress={() => close(true)} />
          </View>
          <ScrollView
            horizontal
            accessibilityRole="tablist"
            showsHorizontalScrollIndicator={false}
            style={{ backgroundColor: colors.page }}
            contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 }}
          >
            {pickerProviders(session.cliStatus, initial.provider, draft.provider).map((provider) => {
              const on = provider === draft.provider;
              const problem = session.cliStatus?.[provider] && session.cliStatus[provider].state !== "ready";
              return (
                <Pressable
                  key={provider}
                  accessibilityRole="tab"
                  accessibilityLabel={providerName(provider)}
                  accessibilityState={{ selected: on }}
                  onPress={() => setDraft((current) => ({ ...current, provider, model: "", fastMode: false, ultracode: false }))}
                  style={({ pressed }) => ({
                    height: 34,
                    paddingHorizontal: 13,
                    borderRadius: 17,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    backgroundColor: on ? colors.ink : colors.surface,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <ProviderLogo provider={provider} size={14} inverted={on} />
                  <Text style={{ color: on ? colors.page : colors.ink2, fontSize: 14, fontWeight: "500" }}>{providerName(provider)}</Text>
                  {problem && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.orange }} />}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
        <View style={{ paddingHorizontal: 16 }}>
          {busy && <Text style={[styles.caption, { paddingBottom: 8 }]}>Changes apply to your next message. This turn keeps its settings.</Text>}
          {cli && cli.state !== "ready" && (
            <Text style={[styles.caption, { color: colors.orangeInk, paddingBottom: 8 }]}>
              {cli.message || `${providerName(draft.provider)} is ${cli.state}.`}
            </Text>
          )}
          {models.map((item, index) => (
            <View key={item.id}>
              {index > 0 && <View style={styles.separator} />}
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: item.id === model.id }}
                onPress={() => setDraft((current) => ({ ...current, model: item.id }))}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, opacity: pressed ? 0.5 : 1 })}
              >
                <ProviderLogo provider={item.provider} size={16} />
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={{ color: colors.ink, fontSize: 15, fontWeight: "500", flexShrink: 1 }}>{item.name}</Text>
                    {!!metaOf(item) && (
                      <Text
                        accessibilityLabel={metaOf(item)?.spoken}
                        style={{
                          color: colors.ink3,
                          fontSize: 11,
                          fontWeight: "500",
                          fontVariant: ["tabular-nums"],
                          borderWidth: StyleSheet.hairlineWidth,
                          borderColor: colors.lineStrong,
                          borderRadius: 5,
                          paddingHorizontal: 4,
                          paddingVertical: 1,
                          overflow: "hidden",
                        }}
                      >
                        {metaOf(item)?.label}
                      </Text>
                    )}
                  </View>
                  {!!item.description && <Text style={styles.caption}>{item.description}</Text>}
                </View>
                {item.id === model.id && <Icon icon={Tick02Icon} tone="ink" size={18} strokeWidth={2.2} />}
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>
      {hasSettings && (
        <View
          onLayout={(event) => setPanelHeight(event.nativeEvent.layout.height)}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: colors.canvas,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.line,
            paddingHorizontal: 16,
            paddingTop: 14,
            paddingBottom: 34,
            gap: 14,
          }}
        >
          {levels.length > 0 && effort && (
            <View style={{ gap: 8 }}>
              <Text style={styles.section}>Thinking effort</Text>
              {levels.length > 1 && (
                <>
                  <EffortSlider
                    index={level}
                    count={levels.length}
                    label="Thinking effort"
                    valueText={effortCopy(effort).name}
                    onChange={(next) => {
                      const nextEffort = levels[next];
                      if (!nextEffort) return;
                      if (nextEffort === "ultra") ultraRumble();
                      setDraft((current) => ({ ...current, effort: nextEffort }));
                    }}
                  />
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={styles.caption}>{effortCopy(levels[0] ?? effort).name}</Text>
                    <Text style={styles.caption}>{effortCopy(levels[levels.length - 1] ?? effort).name}</Text>
                  </View>
                </>
              )}
              <Text style={styles.caption}>
                <Text style={{ color: effort === "ultra" ? colors.purpleInk : colors.ink, fontWeight: "600" }}>{effortCopy(effort).name}</Text>
                {effortCopy(effort).description ? ` · ${effortCopy(effort).description}` : ""}
              </Text>
            </View>
          )}
          {(model.fastMode || model.ultracode) && (
            <View style={{ gap: 8 }}>
              {model.fastMode && (
                <SettingTile
                  icon={FlashIcon}
                  label="Fast mode"
                  title="Fast"
                  detail="Quicker replies, higher usage"
                  value={draft.fastMode}
                  onChange={(value) => setDraft((current) => ({ ...current, fastMode: value }))}
                />
              )}
              {model.ultracode && (
                <SettingTile
                  icon={UserMultipleIcon}
                  label="Ultracode"
                  title="Ultracode"
                  tone="purple"
                  detail="Parallel agents for big work"
                  value={!!draft.ultracode}
                  onChange={(value) => {
                    setDraft((current) => ({ ...current, ultracode: value }));
                    if (!value) return;
                    ultraRumble();
                    if (fatalityOn) setFatality((count) => count + 1);
                  }}
                />
              )}
            </View>
          )}
        </View>
      )}
      {fatality > 0 && <UltracodeFatality key={fatality} onDone={() => setFatality(0)} />}
    </View>
  );
}

function SettingTile({
  icon,
  label,
  title,
  detail,
  value,
  onChange,
  tone = "orange",
}: {
  /** The color the tile takes while on: Fast is orange, Ultracode purple like its Fatality overlay. */
  tone?: "orange" | "purple";
  icon: typeof FlashIcon;
  label: string;
  title: string;
  detail: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const ink = tone === "purple" ? colors.purpleInk : colors.orange;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityHint={detail}
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 11,
        paddingVertical: 11,
        paddingHorizontal: 14,
        borderRadius: 13,
        borderCurve: "continuous",
        backgroundColor: value ? (tone === "purple" ? colors.purpleTint : colors.orangeTint) : colors.surface,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon icon={icon} tone={value ? (tone === "purple" ? "purpleInk" : "orange") : "ink2"} size={18} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: value ? ink : colors.ink, fontSize: 15, fontWeight: "600" }}>{title}</Text>
        <Text style={styles.caption}>{detail}</Text>
      </View>
    </Pressable>
  );
}
