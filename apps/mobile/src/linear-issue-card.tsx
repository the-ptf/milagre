import { Image, Linking, Pressable, Text, View } from "react-native";
import type { LinearIssueContext } from "@milagre/shared/model";
import LINEAR_MARK from "../assets/linear-mark.png";
import { lineHeight, radius, space, type } from "./design-tokens";
import { useTheme } from "./theme";
import { pressStyle } from "./ui";

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
        style={({ pressed }) => pressStyle({ pressed })}
      >
        <View
          style={{
            minWidth: 240,
            gap: space.xs,
            paddingHorizontal: space.xl,
            paddingVertical: space.lg,
            borderRadius: radius.sheet,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: colors.line,
            backgroundColor: colors.surface,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Image source={LINEAR_MARK} style={{ width: 12, height: 12, tintColor: colors.ink3 }} />
            <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500", fontVariant: ["tabular-nums"] }}>
              {issue.key}
            </Text>
            <View style={{ width: 6, height: 6, borderRadius: radius.full, backgroundColor: issue.state.color }} />
            <Text style={{ flexShrink: 1, color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }} numberOfLines={1}>
              {issue.state.name}
            </Text>
          </View>
          <Text style={{ color: colors.ink, fontSize: type.subheadline, fontWeight: "500", lineHeight: lineHeight.subheadline }} numberOfLines={2}>
            {issue.title}
          </Text>
        </View>
      </Pressable>
      {!!issue.note && (
        <View
          style={{
            backgroundColor: colors.canvas,
            borderRadius: radius.sheet,
            borderCurve: "continuous",
            paddingVertical: space.lg,
            paddingHorizontal: space.xl,
          }}
        >
          <Text selectable style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
            {issue.note}
          </Text>
        </View>
      )}
    </View>
  );
}
