import { Pressable, View } from "react-native";
import Reanimated, { useAnimatedStyle } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useTheme } from "./theme";

export function MessageNavigation({
  items,
  onSelect,
  top,
  bottom,
  keyboardOffset,
  followKeyboard = true,
}: {
  items: { index: number; label: string }[];
  onSelect: (index: number) => void;
  top: number;
  bottom: number;
  keyboardOffset: number;
  /** False in an iPad split pane that doesn't hold the keyboard: it stays put while the other pane's composer rises. */
  followKeyboard?: boolean;
}) {
  const { colors } = useTheme();
  const { height, progress } = useReanimatedKeyboardAnimation();
  const keyboardStyle = useAnimatedStyle(() => ({ bottom: followKeyboard ? bottom - height.value - keyboardOffset * progress.value : bottom }));
  if (items.length < 2) return null;
  return (
    <Reanimated.View pointerEvents="box-none" style={[{ position: "absolute", left: 0, top, bottom, width: 24, justifyContent: "center" }, keyboardStyle]}>
      {items.map((item) => (
        <Pressable
          key={item.index}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          onPress={() => onSelect(item.index)}
          style={{ height: 24, flexShrink: 1, width: 24, alignItems: "center", justifyContent: "center" }}
        >
          {({ pressed }) => <View style={{ width: pressed ? 16 : 4, height: 1, backgroundColor: pressed ? colors.ink : colors.lineStrong }} />}
        </Pressable>
      ))}
    </Reanimated.View>
  );
}
