import { effortCopy, PERMISSION_MODE_LABEL, PERMISSION_MODES } from "@milagre/shared/model-copy";
import { effortFor } from "@milagre/shared/model-options";
import { Pressable, Text } from "react-native";
import { ArrowDown01Icon, FlashIcon, Shield01Icon, ShieldAlertIcon, SecurityCheckIcon } from "@hugeicons/core-free-icons";
import type { PermissionMode } from "@milagre/shared/model";
import type { MobileModel } from "./turn-options";
import { Icon, ProviderLogo } from "./icons";
import { useTheme } from "./theme";

/** The composer's model chip: provider logo, model name, the effort ("· Medium", or Ultra while Ultracode is on) and a bolt while fast
 * mode is on. All of them change in the model sheet. */
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
  /** The Chat's picks; each shows only when the model accepts it. */
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
      style={({ pressed }) => ({
        minHeight: 34,
        maxWidth: 230,
        // The composer row also holds the plan pill, the context ring and Send; the model label truncates so Send stays on screen.
        flexShrink: 1,
        paddingHorizontal: 6,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
      })}
    >
      <ProviderLogo provider={model.provider} size={14} />
      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 13, fontWeight: "500", flexShrink: 1 }}>
        {model.name}
      </Text>
      {!!label && !compact && (
        <Text numberOfLines={1} style={{ color: orchestrating ? colors.purpleInk : colors.ink2, fontSize: 13, flexShrink: 2 }}>
          <Text style={{ color: colors.ink3 }}>· </Text>
          {label}
        </Text>
      )}
      {fast && <Icon icon={FlashIcon} tone="orange" size={13} />}
      {!compact && <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />}
    </Pressable>
  );
}

/** The composer's permission chip; it opens the permission sheet. A plain button, so nothing React sits in a native menu. */
export function PermissionChip({ mode, disabled, onPress }: { mode: PermissionMode; disabled?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Permissions, ${PERMISSION_MODES.find((item) => item.id === mode)?.name ?? PERMISSION_MODE_LABEL[mode]}`}
      accessibilityHint="Opens permission modes"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 34,
        paddingHorizontal: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
      })}
    >
      <PermissionIcon mode={mode} size={15} />
      <Text style={{ color: mode === "full" ? colors.orangeInk : colors.ink2, fontSize: 13 }}>{PERMISSION_MODE_LABEL[mode]}</Text>
    </Pressable>
  );
}
export function PermissionIcon({ mode, size }: { mode: PermissionMode; size: number }) {
  return (
    <Icon
      icon={mode === "full" ? ShieldAlertIcon : mode === "auto" ? SecurityCheckIcon : Shield01Icon}
      tone={mode === "full" ? "orange" : "ink2"}
      size={size}
    />
  );
}
