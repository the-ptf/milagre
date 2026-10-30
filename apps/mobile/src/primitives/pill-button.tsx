import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { over } from "@milagre/shared/themes";
import { lineHeight, radius, type } from "../design-tokens";
import { useTheme } from "../theme";
import { Icon, SpinnerRing, type IconData } from "../icons";
import { tap } from "./tap";
import { useHover } from "./hover";
import { pressStyle } from "./press-style";

/** Heights per size, set as `minHeight` so Dynamic Type can grow the pill: 32 inline/compact, 44 default, 52 a sheet's main action. */
const SIZES = {
  small: { minHeight: 32, paddingHorizontal: 12, gap: 6, fontSize: type.footnote, lineHeight: lineHeight.footnote, icon: 16 },
  regular: { minHeight: 44, paddingHorizontal: 16, gap: 8, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, icon: 18 },
  large: { minHeight: 52, paddingHorizontal: 20, gap: 8, fontSize: type.body, lineHeight: lineHeight.body, icon: 20 },
} as const;

/**
 * The phone's one button, a capsule with a 600 label. `primary` is the main action (ink fill, onInk label);
 * `secondary` the surface with a 1px lineStrong edge; `tinted` a field fill; `plain` no fill or edge (a quiet action,
 * Cancel with `muted`). `destructive` makes a primary a redInk fill with an onRedInk label (a destructive confirm, as
 * desktop's danger Button) and the others a redInk label. Without an icon, loading keeps the width and centres the ring.
 */
export function PillButton({
  title,
  onPress,
  icon,
  variant,
  secondary = false,
  destructive = false,
  muted = false,
  disabled = false,
  loading = false,
  size = "regular",
  accessibilityLabel,
  style,
}: {
  title: string;
  onPress: () => void;
  icon?: IconData;
  variant?: "primary" | "secondary" | "tinted" | "plain";
  /** Same as `variant="secondary"`. */
  secondary?: boolean;
  destructive?: boolean;
  /** An ink2 label at 500, for Cancel beside the main action. */
  muted?: boolean;
  disabled?: boolean;
  loading?: boolean;
  size?: keyof typeof SIZES;
  /** What VoiceOver and TalkBack read, when the title alone doesn't say it ("Stop Heartbeat" for "Stop"). */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const { hovered, ...pointer } = useHover();
  const metrics = SIZES[size];
  const kind = variant ?? (secondary ? "secondary" : "primary");
  const filled = kind === "primary";
  const ink = filled ? (destructive ? colors.onRedInk : colors.onInk) : destructive ? colors.redInk : muted ? colors.ink2 : colors.ink;
  const rest = { primary: destructive ? colors.redInk : colors.ink, secondary: colors.surface, tinted: colors.field, plain: "transparent" }[kind];
  // An iPad pointer darkens the quiet pills by the hover overlay; a filled one only reacts to the press.
  const fill = hovered && !filled && !disabled ? (kind === "plain" ? colors.hover : over(colors.hover, rest)) : rest;
  const ring = filled ? <SpinnerRing size={metrics.icon} color={ink} /> : <SpinnerRing size={metrics.icon} tone="ink2" />;
  return (
    <Pressable
      {...pointer}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled, busy: loading }}
      // A small pill still takes a 44pt touch.
      hitSlop={size === "small" ? 6 : undefined}
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        {
          minHeight: metrics.minHeight,
          paddingHorizontal: metrics.paddingHorizontal,
          borderRadius: radius.full,
          borderCurve: "continuous",
          flexDirection: "row",
          gap: metrics.gap,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: fill,
          borderWidth: kind === "secondary" ? 1 : 0,
          borderColor: colors.lineStrong,
        },
        pressStyle({ pressed, disabled, filled }),
        style,
      ]}
    >
      {loading && icon ? ring : icon ? <Icon icon={icon} color={ink} size={metrics.icon} /> : null}
      <Text
        style={{
          color: ink,
          fontSize: metrics.fontSize,
          lineHeight: metrics.lineHeight,
          fontWeight: muted ? "500" : "600",
          opacity: loading && !icon ? 0 : 1,
        }}
      >
        {title}
      </Text>
      {loading && !icon ? (
        <View style={{ position: "absolute", alignItems: "center", justifyContent: "center", top: 0, bottom: 0, left: 0, right: 0 }}>{ring}</View>
      ) : null}
    </Pressable>
  );
}
