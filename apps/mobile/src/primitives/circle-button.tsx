import { Pressable, Text, View } from "react-native";
import { over } from "@milagre/shared/themes";
import { hitSlopFor, lineHeight, radius, type } from "../design-tokens";
import { useTheme } from "../theme";
import { Icon, type IconData } from "../icons";
import { tap } from "./tap";
import { useHover } from "./hover";
import { pressStyle } from "./press-style";

/**
 * The 40pt round outlined button of sheets and panels (close, back, done, a viewer's tools): surface fill, 1px lineStrong
 * edge, 20pt ink glyph. `filled` is the primary (ink fill, onInk glyph); `selected` an on toggle (hover2 fill, ink glyph);
 * `badge` a count on its corner. `disabled` (or no `onPress`) keeps the button role and label, dims it to 40% and reads
 * as dimmed; `asTrigger` draws it enabled with no `onPress`, as a PullDown's child (the menu takes the tap).
 */
export function CircleButton({
  label,
  icon,
  onPress,
  filled = false,
  selected,
  badge,
  asTrigger = false,
  disabled = false,
}: {
  label: string;
  icon: IconData;
  onPress?: () => void;
  filled?: boolean;
  selected?: boolean;
  badge?: number;
  asTrigger?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const { hovered, ...pointer } = useHover();
  const off = disabled || (!onPress && !asTrigger);
  const face = (
    <View
      style={{
        width: 40,
        height: 40,
        borderRadius: radius.full,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: filled ? colors.ink : selected ? colors.hover2 : hovered && !off ? over(colors.hover, colors.surface) : colors.surface,
        borderWidth: filled ? 0 : 1,
        borderColor: colors.lineStrong,
      }}
    >
      <Icon icon={icon} size={20} tone={filled ? "onInk" : "ink"} />
      {badge ? (
        <View
          style={{
            position: "absolute",
            top: -4,
            right: -4,
            minWidth: 20,
            minHeight: 20,
            paddingHorizontal: 4,
            borderRadius: radius.full,
            borderWidth: 2,
            borderColor: colors.surface,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.ink,
          }}
        >
          <Text
            maxFontSizeMultiplier={1.3}
            style={{ color: colors.onInk, fontSize: type.caption2, lineHeight: lineHeight.caption2, fontWeight: "600", fontVariant: ["tabular-nums"] }}
          >
            {badge}
          </Text>
        </View>
      ) : null}
    </View>
  );
  if (asTrigger && !onPress)
    return (
      <View accessible accessibilityRole="button" accessibilityLabel={label} style={disabled ? pressStyle({ pressed: false, disabled }) : undefined}>
        {face}
      </View>
    );
  return (
    <Pressable
      {...pointer}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, selected }}
      hitSlop={hitSlopFor(40)}
      disabled={off}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => pressStyle({ pressed, disabled: off, filled })}
    >
      {face}
    </Pressable>
  );
}
