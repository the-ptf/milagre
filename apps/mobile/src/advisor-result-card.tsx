import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowExpand01Icon, ArrowShrink01Icon } from "@hugeicons/core-free-icons";
import { advisorResultLabel, advisorResultRole } from "@milagre/shared/advisor-result";
import type { AdvisorResultContext } from "@milagre/shared/model";
import { Icon, ProviderLogo } from "./icons";
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
  // Collapsed, the card keeps a fixed height and scrolls; expanded, it grows to show the whole result.
  const [expanded, setExpanded] = useState(false);
  const resultLabel = context.mode === "execution" ? "execution result" : "advisor result";
  const resultMedia = useMemo(
    () => (media ? (path: string) => media(context.images?.find((image) => image.sourcePath === path || image.path === path)?.path ?? path) : undefined),
    [media, context.images],
  );
  const markdown = <Markdown text={body} media={resultMedia} basePath={basePath} />;
  return (
    <View
      testID="advisor-result"
      style={{
        height: expanded ? undefined : 286,
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
          <Text style={{ color: colors.ink2, fontSize: 12, fontWeight: "500", flex: 1 }}>{advisorResultRole(context)}</Text>
          {context.outcome !== "completed" && (
            <Text style={{ color: context.outcome === "failed" ? colors.red : colors.ink2, fontSize: 12 }}>
              {context.outcome === "failed" ? "Failed" : "Stopped"}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${resultLabel}`}
            accessibilityState={{ expanded }}
            hitSlop={10}
            onPress={() => setExpanded((open) => !open)}
            style={({ pressed }) => ({ marginVertical: -4, marginRight: -4, padding: 4, opacity: pressed ? 0.5 : 1 })}
          >
            <Icon icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon} size={15} tone="ink3" />
          </Pressable>
        </View>
        <Text selectable accessibilityRole="header" numberOfLines={2} style={{ color: colors.ink, fontSize: 16, lineHeight: 22, fontWeight: "600" }}>
          {context.title}
        </Text>
      </View>
      {expanded ? (
        <View accessibilityLabel={advisorResultLabel(context)} style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 }}>
          {markdown}
        </View>
      ) : (
        <PageScroll
          fadeEdges
          accessibilityLabel={advisorResultLabel(context)}
          nestedScrollEnabled
          contentInsetAdjustmentBehavior="never"
          style={{ flex: 1, marginBottom: 8, borderRadius: 8 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, gap: 0 }}
        >
          {markdown}
        </PageScroll>
      )}
    </View>
  );
}
