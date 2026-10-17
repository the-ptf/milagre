import { Text, View } from "react-native";
import { advisorResultLabel } from "@milagre/shared/advisor-result";
import type { AdvisorResultContext } from "@milagre/shared/model";
import { providerName } from "@milagre/shared/providers";
import { ProviderLogo } from "./icons";
import { Markdown } from "./markdown";
import type { MediaSource } from "./chat-reply";
import { useTheme } from "./theme";
import { PageScroll } from "./ui";

export function AdvisorResultCard({
  context,
  body,
  highlighted,
  media,
  basePath,
}: {
  context: AdvisorResultContext;
  body: string;
  highlighted?: boolean;
  media?: MediaSource;
  basePath?: string;
}) {
  const { colors } = useTheme();
  return (
    <View
      testID="advisor-result"
      style={{
        height: 286,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.line,
        borderRadius: 14,
        borderCurve: "continuous",
        ...(highlighted ? { outlineWidth: 1.5, outlineColor: colors.accent, outlineStyle: "solid" as const } : {}),
      }}
    >
      <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ProviderLogo provider={context.provider} size={18} />
          <Text style={{ color: colors.ink2, fontSize: 12, fontWeight: "500", flex: 1 }}>{providerName(context.provider)} advisor</Text>
          {context.outcome !== "completed" && (
            <Text style={{ color: context.outcome === "failed" ? colors.red : colors.ink2, fontSize: 12 }}>
              {context.outcome === "failed" ? "Failed" : "Stopped"}
            </Text>
          )}
        </View>
        <Text selectable accessibilityRole="header" numberOfLines={2} style={{ color: colors.ink, fontSize: 16, lineHeight: 22, fontWeight: "600" }}>
          {context.title}
        </Text>
      </View>
      <PageScroll
        fadeEdges
        accessibilityLabel={advisorResultLabel(context)}
        nestedScrollEnabled
        contentInsetAdjustmentBehavior="never"
        style={{ flex: 1, marginBottom: 8, borderRadius: 8 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, gap: 0 }}
      >
        <Markdown text={body} media={media} basePath={basePath} />
      </PageScroll>
    </View>
  );
}
