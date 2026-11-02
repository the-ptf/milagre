import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon, type IconData, type Tone } from "./icons";
import type { StepLook } from "./flow-looks";
import { tap } from "./ui";
import { useTheme } from "./theme";

/** A step type's icon on its tinted square, as the editor's cards and the Add step sheet show it. */
export function StepTile({ look, size = 36 }: { look: StepLook; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors[look.tint] as string,
      }}
    >
      <Icon icon={look.icon} tone={look.tone} size={Math.round(size * 0.5)} />
    </View>
  );
}

/**
 * The flow screens' buttons, as the designs draw them: `primary` on the accent (Publish, Approve), `secondary` on the field
 * fill (Test run, Reject), `quiet` as a link (Change how long approvals wait).
 */
export function FlowButton({
  title,
  onPress,
  kind = "primary",
  icon,
  disabled = false,
  loading = false,
  compact = false,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "quiet" | "danger";
  icon?: IconData;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const ink = kind === "primary" ? colors.onAccent : kind === "quiet" ? colors.accentInk : kind === "danger" ? colors.redInk : colors.ink;
  const tone: Tone = kind === "primary" ? "onAccent" : kind === "quiet" ? "accentInk" : kind === "danger" ? "redInk" : "ink";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        {
          minHeight: compact ? 36 : kind === "quiet" ? 32 : 48,
          paddingHorizontal: compact ? 14 : 18,
          borderRadius: 14,
          borderCurve: "continuous",
          flexDirection: "row",
          gap: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: kind === "primary" ? colors.accent : kind === "quiet" ? "transparent" : colors.field,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={ink} /> : icon ? <Icon icon={icon} tone={tone} size={compact ? 16 : 18} /> : null}
      <Text numberOfLines={1} style={{ color: ink, fontSize: compact ? 14 : 16, fontWeight: kind === "quiet" ? "500" : "600" }}>
        {title}
      </Text>
    </Pressable>
  );
}

/** A small status pill: "On, revision 4" in green, "Waiting for you" in orange, "Draft, 3 changes" on the field fill. */
export function FlowChip({
  text,
  tone = "neutral",
  icon,
  dot = false,
  trailing,
}: {
  text: string;
  tone?: "neutral" | "green" | "orange" | "red" | "accent";
  icon?: IconData;
  dot?: boolean;
  trailing?: IconData;
}) {
  const { colors } = useTheme();
  const fill = { neutral: colors.field, green: colors.greenTint, orange: colors.orangeTint, red: colors.redTint, accent: colors.accentTint }[tone];
  const ink = { neutral: colors.ink2, green: colors.greenInk, orange: colors.orangeInk, red: colors.redInk, accent: colors.accentInk }[tone];
  const dotColor = { neutral: colors.ink3, green: colors.green, orange: colors.orange, red: colors.red, accent: colors.accent }[tone];
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 26,
        paddingHorizontal: 9,
        borderRadius: 10,
        backgroundColor: fill,
        alignSelf: "flex-start",
      }}
    >
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 6, backgroundColor: dotColor }} /> : null}
      {icon ? <Icon icon={icon} color={ink} size={14} /> : null}
      <Text numberOfLines={1} style={{ color: ink, fontSize: 13, fontWeight: "600" }}>
        {text}
      </Text>
      {trailing ? <Icon icon={trailing} color={ink} size={13} /> : null}
    </View>
  );
}

/** A tinted note box: orange for "Run 14 keeps revision 4", red for an error, the field fill for a plain note. */
export function FlowNote({ tone = "neutral", icon, children }: { tone?: "neutral" | "orange" | "red" | "green"; icon?: IconData; children: ReactNode }) {
  const { colors } = useTheme();
  const fill = { neutral: colors.field, orange: colors.orangeTint, red: colors.redTint, green: colors.greenTint }[tone];
  const ink = { neutral: colors.ink2, orange: colors.orangeInk, red: colors.redInk, green: colors.greenInk }[tone];
  return (
    <View style={{ flexDirection: "row", gap: 10, padding: 14, borderRadius: 14, borderCurve: "continuous", backgroundColor: fill }}>
      {icon ? (
        <View style={{ paddingTop: 1 }}>
          <Icon icon={icon} color={ink} size={17} />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 8 }}>
        {typeof children === "string" ? <Text style={{ color: ink, fontSize: 15, lineHeight: 20 }}>{children}</Text> : children}
      </View>
    </View>
  );
}
