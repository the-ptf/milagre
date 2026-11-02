import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { lineHeight, radius, space, type } from "./design-tokens";
import { useTheme } from "./theme";
import { pressStyle } from "./ui";

export function FileChip({ path }: { path: string }) {
  const { colors } = useTheme();
  const name = path.split(/[\\/]/).pop() || path;
  const ext = name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Preview ${name}`}
      onPress={() => router.push({ pathname: "/file-preview", params: { path } })}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: space.lg,
          paddingVertical: space.md,
          paddingLeft: space.md,
          paddingRight: space.lg,
          borderRadius: radius.card,
          borderCurve: "continuous",
          backgroundColor: colors.canvas,
          maxWidth: 264,
        },
        pressStyle({ pressed }),
      ]}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: radius.chip,
          borderCurve: "continuous",
          backgroundColor: colors.surface,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: ext === "PDF" ? colors.redInk : colors.ink2, fontSize: type.caption2, lineHeight: lineHeight.caption2, fontWeight: "600" }}>
          {ext}
        </Text>
      </View>
      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500", flexShrink: 1 }}>
        {name}
      </Text>
    </Pressable>
  );
}
