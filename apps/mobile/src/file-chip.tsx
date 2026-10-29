import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useTheme } from "./theme";

export function FileChip({ path }: { path: string }) {
  const { colors } = useTheme();
  const name = path.split(/[\\/]/).pop() || path;
  const ext = name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Preview ${name}`}
      onPress={() => router.push({ pathname: "/file-preview", params: { path } })}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 8,
        paddingLeft: 8,
        paddingRight: 12,
        borderRadius: 14,
        borderCurve: "continuous",
        backgroundColor: colors.canvas,
        maxWidth: 264,
      }}
    >
      <View style={{ width: 34, height: 34, borderRadius: 8, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: ext === "PDF" ? colors.redInk : colors.ink2, fontSize: 9, fontWeight: "700" }}>{ext}</Text>
      </View>
      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 14, fontWeight: "500", flexShrink: 1 }}>
        {name}
      </Text>
    </Pressable>
  );
}
