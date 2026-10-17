import { Image, Linking, Pressable, Text, View } from "react-native";
import type { LinearIssueContext } from "@milagre/shared/model";
import LINEAR_MARK from "../assets/linear-mark.png";
import { useTheme } from "./theme";

/** A Chat started from a Linear issue, shown as the issue instead of the prompt the agent read. Tapping opens it in Linear. */
export function LinearIssueCard({ issue }: { issue: LinearIssueContext }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: "flex-end", gap: 6 }}>
      <Pressable
        accessibilityRole={issue.url ? "link" : undefined}
        accessibilityLabel={issue.url ? `Open Linear issue ${issue.key}: ${issue.title}` : `Linear issue ${issue.key}: ${issue.title}`}
        // A Routine Run's card has no link when the issue's URL wasn't Linear's own.
        disabled={!issue.url}
        onPress={() => void Linking.openURL(issue.url).catch(() => {})}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <View
          style={{
            minWidth: 240,
            gap: 4,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 18,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: colors.line,
            backgroundColor: colors.surface,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Image source={LINEAR_MARK} style={{ width: 13, height: 13, tintColor: colors.ink3 }} />
            <Text style={{ color: colors.ink3, fontSize: 13, fontWeight: "500", fontVariant: ["tabular-nums"] }}>{issue.key}</Text>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: issue.state.color }} />
            <Text style={{ flexShrink: 1, color: colors.ink3, fontSize: 13 }} numberOfLines={1}>
              {issue.state.name}
            </Text>
          </View>
          <Text style={{ color: colors.ink, fontSize: 15, fontWeight: "500", lineHeight: 20 }} numberOfLines={2}>
            {issue.title}
          </Text>
        </View>
      </Pressable>
      {!!issue.note && (
        <View style={{ backgroundColor: colors.canvas, borderRadius: 18, borderCurve: "continuous", paddingVertical: 10, paddingHorizontal: 14 }}>
          <Text selectable style={{ color: colors.ink, fontSize: 15, lineHeight: 22 }}>
            {issue.note}
          </Text>
        </View>
      )}
    </View>
  );
}
