import { Linking, Pressable, Text, View } from "react-native";
import type { GitHubIssueContext } from "@milagre/shared/github-issue";
import { useTheme } from "./theme";
import { lineHeight, radius, space, type } from "./design-tokens";
import { pressStyle } from "./ui";

export function GitHubIssueCard({ issue }: { issue: GitHubIssueContext }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: "flex-end", gap: space.xs }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open GitHub issue ${issue.repository}#${issue.number}: ${issue.title}`}
        onPress={() => void Linking.openURL(issue.url).catch(() => {})}
        style={({ pressed }) => pressStyle({ pressed })}
      >
        <View
          style={{ gap: space.xs, padding: space.xl, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, borderRadius: radius.sheet }}
        >
          <Text style={{ color: colors.ink3, fontSize: type.footnote }}>
            {issue.repository}#{issue.number}
          </Text>
          <Text style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" }}>{issue.title}</Text>
          <Text style={{ color: colors.ink3, fontSize: type.footnote }}>Imported {new Date(issue.importedAt).toLocaleString()}</Text>
        </View>
      </Pressable>
      {!!issue.note && (
        <Text selectable style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
          {issue.note}
        </Text>
      )}
    </View>
  );
}
