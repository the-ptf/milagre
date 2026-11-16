import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { pressStyle } from "./ui";
import { tap } from "./primitives/tap";
import { useTheme } from "./theme";
import { useAttention } from "./attention";
import { bookmarkOf, type Bookmark } from "./subchat-family";
import type { AgentSession } from "@milagre/shared/model";
import { useRun } from "./session";

/** The capsule's height; the touch area is 44 with the slop. */
const HEIGHT = 32;

function SubchatBookmark({ bookmark, top, onBack }: { bookmark: Bookmark; top: number; onBack: () => void }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const { needsYou, running, title } = bookmark;
  const dot = needsYou ? colors.orange : running ? colors.accent : colors.ink4;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top, left: space.gutter, maxWidth: width - 2 * space.gutter }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Back to ${title}${needsYou ? ", needs you" : ""}`}
        accessibilityHint="Opens the Chat above this one"
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        onPress={() => {
          tap();
          onBack();
        }}
        style={({ pressed }) => [
          {
            height: HEIGHT,
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingLeft: space.md,
            paddingRight: space.lg,
            borderRadius: radius.full,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: colors.line,
            backgroundColor: needsYou ? colors.orangeTint : colors.surface,
          },
          pressStyle({ pressed }),
        ]}
      >
        <Icon icon={ArrowLeft01Icon} tone={needsYou ? "orange" : "ink2"} size={16} />
        <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: dot }} />
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, color: needsYou ? colors.ink : colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}
        >
          {title}
        </Text>
        {needsYou && (
          <Text style={{ flexShrink: 0, color: colors.orangeInk, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}>Needs you</Text>
        )}
      </Pressable>
    </View>
  );
}

export function SubchatBookmarkHost({
  sessions,
  chatKey,
  top,
  onBack,
}: {
  sessions: Record<number, AgentSession | undefined>;
  chatKey: string;
  top: number;
  onBack: (parentKey: string) => void;
}) {
  const attention = useAttention();
  const parent = bookmarkOf({ sessions, key: chatKey, attention: [], runs: undefined })?.parent;
  const parentRun = useRun(parent);
  const bookmark = bookmarkOf({ sessions, key: chatKey, attention, runs: parent && parentRun ? { [parent]: parentRun } : undefined });
  return bookmark ? <SubchatBookmark bookmark={bookmark} top={top} onBack={() => onBack(bookmark.parent)} /> : null;
}
