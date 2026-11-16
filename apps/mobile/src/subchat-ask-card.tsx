import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { lineHeight, radius, space, type } from "./design-tokens";
import { pressStyle } from "./ui";
import { useTheme } from "./theme";

export const SubchatAskCard = memo(function SubchatAskCard({ title, rest, ask, onOpen }: { title: string; rest: string; ask: string; onOpen: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title} needs you${rest ? `. ${rest}` : ""}. ${ask}`}
      accessibilityHint="Opens that Subchat"
      onPress={onOpen}
      style={({ pressed }) => [
        {
          minHeight: 44,
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          gap: space.xxs,
          borderRadius: radius.card,
          borderCurve: "continuous",
          backgroundColor: colors.orangeTint,
          borderWidth: 1,
          borderColor: colors.line,
        },
        pressStyle({ pressed }),
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.orange }} />
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
          <Text
            numberOfLines={1}
            style={{ flexShrink: 1, color: colors.orangeInk, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600" }}
          >
            {title}
          </Text>
          <Text style={{ flexShrink: 0, color: colors.orangeInk, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600" }}>
            {" needs you"}
          </Text>
        </View>
        {!!rest && <Text style={{ flexShrink: 0, color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{rest}</Text>}
      </View>
      <Text style={{ marginLeft: 16, color: colors.ink, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{ask}</Text>
    </Pressable>
  );
});
