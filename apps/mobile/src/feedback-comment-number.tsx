import { Text, View } from "react-native";
import { useTheme } from "./theme";
import { lineHeight, radius, type } from "./design-tokens";

export function CommentNumber({ number, resolved }: { number: number; resolved: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        minWidth: 20,
        minHeight: 20,
        paddingHorizontal: 4,
        borderRadius: radius.full,
        borderTopLeftRadius: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: resolved ? colors.greenInk : colors.accentInk,
      }}
    >
      <Text
        maxFontSizeMultiplier={1.3}
        style={{
          color: resolved ? colors.onGreen : colors.onAccent,
          fontSize: type.caption2,
          lineHeight: lineHeight.caption2,
          fontWeight: "600",
        }}
      >
        {number}
      </Text>
    </View>
  );
}
