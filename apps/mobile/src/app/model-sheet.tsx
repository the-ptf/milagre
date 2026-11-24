import { installableProviders, pickerProviders, providerName } from "@milagre/shared/providers";
import { contextWindowFor, effortFor, modelMatches } from "@milagre/shared/model-options";
import { formatTokens } from "@milagre/shared/usage";
import { formatCredits } from "@milagre/shared/kiro-models";
import { effortCopy } from "@milagre/shared/model-copy";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { Add01Icon, Cancel01Icon, FlashIcon, Search01Icon, Tick02Icon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import type { AgentCliStatus, ModelProvider } from "@milagre/shared/model";
import { useComposer, useSession } from "../session";
import { PermissionChip, useChatPermissionMode } from "../agent-controls";
import { modelsFor, selectedModel, afterSheet, type TurnPreferences } from "../turn-options";
import { Icon, ProviderLogo } from "../icons";
import { EffortSlider } from "../effort-slider";
import { InstallOffer } from "../install-offer";
import { UltracodeFatality } from "../ultracode-fatality";
import { ultraRumble } from "../ultra-haptics";
import { useUltracodeFatality } from "../ultracode-fatality-setting";
import { CheckRow, Chip, CircleButton, Field, InlineError, SectionLabel, SheetHeader, pressStyle, useSheetBottomInset, useStyles } from "../ui";
import { lineHeight, radius, space, type } from "../design-tokens";
import { useTheme } from "../theme";

const SEARCH_FROM = 12;

function contextLabel(model: { provider: ModelProvider; id: string; contextWindow?: number }) {
  const size = contextWindowFor(model);
  return size ? formatTokens(size) : undefined;
}

function metaOf(model: { provider: ModelProvider; id: string; credits?: number; contextWindow?: number }) {
  if (model.credits) return { label: formatCredits(model.credits), spoken: `${formatCredits(model.credits)} the credits Auto would use` };
  const label = contextLabel(model);
  return label ? { label, spoken: `${label} context window` } : null;
}

export default function ModelSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const bottomInset = useSheetBottomInset();
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
  const [query, setQuery] = useState("");
  const installable = installableProviders(session.cliStatus);
  const [adding, setAdding] = useState(false);
  // Pi can list hundreds of hosted models (OpenRouter alone), so a long list gets a search and provider headings.
  const searchable = models.length > SEARCH_FROM;
  const shown = searchable ? models.filter((item) => modelMatches(item, query)) : models;
  const grouped = new Set(shown.map((item) => item.group).filter(Boolean)).size > 1;
  const effort = effortFor(model, draft.effort);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const [closing, setClosing] = useState(false);
  const [fatality, setFatality] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const hasSettings = model.efforts.length > 0 || model.fastMode || model.ultracode;
  const permissionMode = useChatPermissionMode(params.chatId);
  const [fatalityOn] = useUltracodeFatality();
  usePreventRemove(dirty && !closing, ({ repeat }) =>
    Alert.alert("Discard changes?", "Your model and effort picks will not be applied.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
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
    <View collapsable={false} style={styles.screen}>
      <ScrollView
        style={{ flex: 1 }}
        stickyHeaderIndices={[0]}
        contentContainerStyle={{ paddingBottom: 16 + panelHeight }}
        scrollIndicatorInsets={{ bottom: panelHeight }}
      >
        <View style={{ backgroundColor: colors.page }}>
          <SheetHeader
            title="Model"
            style={{ backgroundColor: colors.page }}
            leading={<CircleButton label="Cancel" icon={Cancel01Icon} onPress={() => close(false)} />}
            trailing={<CircleButton label="Done" icon={Tick02Icon} filled onPress={() => close(true)} />}
          />
          <ProviderChips
            providers={pickerProviders(session.cliStatus, initial.provider, draft.provider)}
            provider={adding ? null : draft.provider}
            cliStatus={session.cliStatus}
            canAdd={installable.length > 0}
            adding={adding}
            onProviderChange={(provider) => {
              setAdding(false);
              setQuery("");
              setDraft((current) => ({ ...current, provider, model: "", fastMode: false, ultracode: false }));
            }}
            onAdd={() => setAdding(true)}
          />
        </View>
        {adding ? (
          <View style={{ paddingHorizontal: 16, gap: 12 }}>
            {installable.map((provider) => (
              <InstallOffer key={provider} provider={provider} />
            ))}
          </View>
        ) : (
          <View accessibilityRole="radiogroup" accessibilityLabel="Model" style={{ paddingHorizontal: 16 }}>
            {busy && <Text style={[styles.caption, { paddingBottom: 8 }]}>Changes apply to your next message. This turn keeps its settings.</Text>}
            {cli && cli.state !== "ready" ? (
              <InlineError warning message={cli.message || `${providerName(draft.provider)} is ${cli.state}.`} style={{ paddingBottom: 8 }} />
            ) : null}
            {searchable && (
              <Field
                label="Search models"
                hideLabel
                placeholder="Search models"
                value={query}
                onChangeText={setQuery}
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
                leading={<Icon icon={Search01Icon} tone="ink3" size={16} />}
                containerStyle={{ paddingBottom: space.md }}
              />
            )}
            {shown.length === 0 && <Text style={[styles.caption, { paddingVertical: 8 }]}>No models found</Text>}
            {shown.map((item, index) => (
              <View key={item.id}>
                {grouped && item.group !== shown[index - 1]?.group ? (
                  <SectionLabel flush style={{ paddingTop: index > 0 ? 16 : 0 }}>
                    {item.group ?? ""}
                  </SectionLabel>
                ) : (
                  index > 0 && <View style={styles.separator} />
                )}
                <CheckRow
                  title={item.name}
                  subtitle={item.description || undefined}
                  checked={item.id === model.id}
                  onPress={() => setDraft((current) => ({ ...current, model: item.id }))}
                  leading={<ProviderLogo provider={item.provider} size={16} />}
                  accessory={
                    metaOf(item) ? (
                      <Text
                        accessibilityLabel={metaOf(item)?.spoken}
                        style={{
                          color: colors.ink3,
                          fontSize: type.caption2,
                          lineHeight: lineHeight.caption2,
                          fontWeight: "500",
                          fontVariant: ["tabular-nums"],
                          borderWidth: 1,
                          borderColor: colors.lineStrong,
                          borderRadius: radius.chip,
                          borderCurve: "continuous",
                          paddingHorizontal: 4,
                          paddingVertical: 2,
                          overflow: "hidden",
                        }}
                      >
                        {metaOf(item)?.label}
                      </Text>
                    ) : undefined
                  }
                />
              </View>
            ))}
          </View>
        )}
      </ScrollView>
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
          paddingTop: hasSettings ? 16 : 4,
          paddingBottom: bottomInset,
          gap: hasSettings ? 16 : 0,
        }}
      >
        {levels.length > 0 && effort && (
          <View style={{ gap: 8 }}>
            <SectionLabel flush>Thinking effort</SectionLabel>
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
        <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: hasSettings ? -8 : 0, marginRight: -8 }}>
          <PermissionChip
            mode={permissionMode}
            onPress={() => router.push({ pathname: "/permission-sheet", params: { chatId: params.chatId, ...(busy ? { busy: "1" } : {}) } })}
          />
        </View>
      </View>
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
  const ink = tone === "purple" ? colors.purpleInk : colors.orangeInk;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityHint={detail}
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingVertical: 12,
          paddingHorizontal: 16,
          minHeight: 56,
          borderRadius: radius.card,
          borderCurve: "continuous",
          backgroundColor: value ? (tone === "purple" ? colors.purpleTint : colors.orangeTint) : colors.surface,
          borderWidth: 1,
          borderColor: value ? "transparent" : colors.line,
        },
        pressStyle({ pressed }),
      ]}
    >
      <Icon icon={icon} tone={value ? tone : "ink2"} size={18} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: value ? ink : colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>{title}</Text>
        <Text style={styles.caption}>{detail}</Text>
      </View>
    </Pressable>
  );
}

/** The provider chips under the sheet's title, and an Add chip that offers an opt-in agent that isn't installed. */
function ProviderChips({
  providers,
  provider: current,
  cliStatus,
  canAdd,
  adding,
  onProviderChange,
  onAdd,
}: {
  providers: ModelProvider[];
  provider: ModelProvider | null;
  cliStatus: AgentCliStatus | null | undefined;
  canAdd: boolean;
  adding: boolean;
  onProviderChange: (provider: ModelProvider) => void;
  onAdd: () => void;
}) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      accessibilityRole="tablist"
      showsHorizontalScrollIndicator={false}
      style={{ backgroundColor: colors.page }}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}
    >
      {providers.map((provider) => {
        const on = provider === current;
        const problem = cliStatus?.[provider] && cliStatus[provider].state !== "ready";
        return (
          <Chip
            key={provider}
            role="tab"
            label={providerName(provider)}
            selected={on}
            onPress={() => onProviderChange(provider)}
            leading={<ProviderLogo provider={provider} size={16} inverted={on} />}
            trailing={problem ? <View style={{ width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.orange }} /> : undefined}
          />
        );
      })}
      {canAdd && (
        <Chip role="tab" label="Add" selected={adding} onPress={onAdd} leading={<Icon icon={Add01Icon} size={16} tone={adding ? "onInk" : "ink2"} />} />
      )}
    </ScrollView>
  );
}
