import { effortCopy, PERMISSION_MODE_LABEL, PERMISSION_MODES, permissionPresentation } from "@milagre/shared/model-copy";
import { effortFor } from "@milagre/shared/model-options";
import { Pressable, Text } from "react-native";
import { ArrowDown01Icon, FlashIcon, Shield01Icon, ShieldAlertIcon, SecurityCheckIcon } from "@hugeicons/core-free-icons";
import type { PermissionMode } from "@milagre/shared/model";
import type { MobileModel } from "./turn-options";
import { Icon, ProviderLogo } from "./icons";
import { hitSlopFor, lineHeight, type } from "./design-tokens";
import { useTheme } from "./theme";
import { pressStyle } from "./ui";
import { useComposer, useSession } from "./session";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { chatPreferences } from "./turn-options";

export function AgentControls({
  model,
  effort,
  fastMode,
  ultracode,
  disabled,
  compact = false,
  onToggle,
}: {
  model: MobileModel;
  effort?: string;
  fastMode?: boolean;
  ultracode?: boolean;
  disabled?: boolean;
  compact?: boolean;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  const level = effortFor(model, effort ?? "");
  const ultracodeOn = model.ultracode && !!ultracode;
  const fast = model.fastMode && !!fastMode;
  const orchestrating = ultracodeOn || level === "ultra";
  const label = ultracodeOn ? "Ultra" : level ? effortCopy(level).name : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={["Model", model.name, label, fast ? "fast mode" : ""].filter(Boolean).join(", ")}
      accessibilityHint="Opens model, effort and speed settings"
      disabled={disabled}
      onPress={onToggle}
      // A 32pt chip in the dense composer tray still takes a 44pt touch.
      hitSlop={hitSlopFor(32)}
      style={({ pressed }) => [
        {
          minHeight: 32,
          maxWidth: 230,
          flexShrink: 1,
          paddingHorizontal: 6,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        },
        pressStyle({ pressed, disabled }),
      ]}
    >
      <ProviderLogo provider={model.provider} size={16} />
      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500", flexShrink: 1 }}>
        {model.name}
      </Text>
      {!!label && !compact && (
        <Text
          numberOfLines={1}
          style={{ color: orchestrating ? colors.purpleInk : colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, flexShrink: 2 }}
        >
          <Text style={{ color: colors.ink3 }}>· </Text>
          {label}
        </Text>
      )}
      {fast && <Icon icon={FlashIcon} tone="orange" size={12} />}
      {!compact && <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />}
    </Pressable>
  );
}

export function useChatPermissionMode(chatId: string): PermissionMode {
  const composer = useComposer();
  const session = useSession();
  const project = session.snapshot?.project;
  const chatMode =
    !/#new:/.test(chatId) && project?.path === projectOfKey(chatId) ? project.state.sessions[sessionIdFromKey(chatId)]?.permissionMode : undefined;
  return chatPreferences(composer.preferences[chatId], composer.defaults, chatMode, session.snapshot?.runs.runs[chatId]?.permissionMode).permissionMode;
}

/** The model sheet's permission chip, in its footer as on desktop (Full in orange); it opens the permission sheet. A plain
 * button, so nothing React sits in a native menu. */
export function PermissionChip({ mode, disabled, onPress }: { mode: PermissionMode; disabled?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const { ink } = permissionPresentation(mode);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Permissions, ${PERMISSION_MODES.find((item) => item.id === mode)?.name ?? PERMISSION_MODE_LABEL[mode]}`}
      accessibilityHint="Opens permission modes"
      disabled={disabled}
      onPress={onPress}
      hitSlop={hitSlopFor(32)}
      style={({ pressed }) => [
        {
          minHeight: 32,
          paddingHorizontal: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        },
        pressStyle({ pressed, disabled }),
      ]}
    >
      <PermissionIcon mode={mode} size={16} />
      <Text style={{ color: colors[ink], fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}>{PERMISSION_MODE_LABEL[mode]}</Text>
    </Pressable>
  );
}
const PERMISSION_ICONS = { shield: Shield01Icon, "security-check": SecurityCheckIcon, "shield-alert": ShieldAlertIcon } as const;

export function PermissionIcon({ mode, size }: { mode: PermissionMode; size: 16 | 20 }) {
  const { icon, tone } = permissionPresentation(mode);
  return <Icon icon={PERMISSION_ICONS[icon]} tone={tone} size={size} />;
}
