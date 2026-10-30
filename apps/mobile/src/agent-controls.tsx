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

/** The composer's model chip: provider logo, model name, the effort ("· Medium", or Ultra while Ultracode is on) and a bolt while fast
 * mode is on. All of them change in the model sheet. */
export function AgentControls({
  model,
  effort,
  fastMode,
  ultracode,
  disabled,
  onToggle,
}: {
  model: MobileModel;
  /** The Chat's picks; each shows only when the model accepts it. */
  effort?: string;
  fastMode?: boolean;
  ultracode?: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  const level = effortFor(model, effort ?? "");
  const ultracodeOn = model.ultracode && !!ultracode;
  const fast = model.fastMode && !!fastMode;
  // Ultracode and the ultra level both hand work to parallel agents: they share Ultracode's purple.
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
          // The composer row also holds the plan pill, the context ring and Send; the model label truncates so Send stays on screen.
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
      {!!label && (
        <Text
          numberOfLines={1}
          style={{ color: orchestrating ? colors.purpleInk : colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, flexShrink: 2 }}
        >
          <Text style={{ color: colors.ink3 }}>· </Text>
          {label}
        </Text>
      )}
      {fast && <Icon icon={FlashIcon} tone="orange" size={12} />}
      <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
    </Pressable>
  );
}

/** The composer's permission chip; it opens the permission sheet. A plain button, so nothing React sits in a native menu. */
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

/** A permission mode's glyph (permissionPresentation): 16 on the chip, 20 in the sheet; Full is the only orange one. */
export function PermissionIcon({ mode, size }: { mode: PermissionMode; size: 16 | 20 }) {
  const { icon, tone } = permissionPresentation(mode);
  return <Icon icon={PERMISSION_ICONS[icon]} tone={tone} size={size} />;
}
