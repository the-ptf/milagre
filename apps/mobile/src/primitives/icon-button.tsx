import { Pressable, type ColorValue } from "react-native";
import { hitSlopFor, radius } from "../design-tokens";
import { useTheme } from "../theme";
import { Icon, SpinnerRing, type IconData, type Tone } from "../icons";
import { tap } from "./tap";
import { useHover } from "./hover";
import { pressStyle } from "./press-style";

const ICON = { 32: 16, 36: 20, 40: 20, 44: 20, 48: 24 } as const;
export type IconButtonSize = keyof typeof ICON;

export function IconButton({
  label,
  icon,
  onPress,
  disabled = false,
  filled = false,
  fill,
  selected,
  loading = false,
  tone = "ink2",
  size = 36,
}: {
  label: string;
  icon: IconData;
  onPress: () => void;
  disabled?: boolean;
  filled?: boolean;
  fill?: ColorValue;
  selected?: boolean;
  loading?: boolean;
  tone?: Tone;
  size?: IconButtonSize;
}) {
  const { colors } = useTheme();
  const { hovered, ...pointer } = useHover();
  const glyph = ICON[size];
  const background = filled ? (fill ?? colors.ink) : selected ? colors.hover2 : hovered && !disabled ? colors.hover : "transparent";
  return (
    <Pressable
      {...pointer}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading, selected }}
      hitSlop={hitSlopFor(size)}
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        { width: size, height: size, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: background },
        pressStyle({ pressed, disabled, filled }),
      ]}
    >
      {loading ? (
        filled ? (
          <SpinnerRing size={glyph} color={colors.onInk} />
        ) : (
          <SpinnerRing size={glyph} tone="ink2" />
        )
      ) : (
        <Icon icon={icon} size={glyph} tone={filled ? "onInk" : selected ? "ink" : tone} />
      )}
    </Pressable>
  );
}
