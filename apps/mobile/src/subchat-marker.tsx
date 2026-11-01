import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowDown01Icon, ArrowRight01Icon, CornerDownRightIcon } from "@hugeicons/core-free-icons";
import type { SubchatKind } from "@milagre/shared/subchat-states";
import { radius, type } from "./design-tokens";
import { Icon } from "./icons";
import { Markdown } from "./markdown";
import type { MediaValue } from "./viewer-store";
import { useTheme } from "./theme";

/**
 * A Subchat's Delegation report in the transcript, as one grey line ("Fix the login finished"): its name opens that Chat,
 * the chevron opens the report in place, in a bordered block. A failed report reads red, a stopped one grey.
 */
export function SubchatMarker({
  marker,
  chat,
  body,
  onOpenChat,
  media,
  basePath,
}: {
  marker: { text: string; kind: SubchatKind };
  /** The Subchat's key, to open it; null when there is none to open. */
  chat: string | null;
  body: string;
  onOpenChat?: (chatKey: string) => void;
  media?: (path: string) => MediaValue;
  basePath?: string;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const failed = marker.kind === "failed";
  const open = chat && onOpenChat ? () => onOpenChat(chat) : undefined;
  const ink = failed ? colors.redInk : colors.ink3;
  const hasBody = !!body.trim();
  return (
    <View style={{ gap: 8, paddingVertical: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Pressable
          accessibilityRole={open ? "link" : "text"}
          accessibilityLabel={marker.text}
          accessibilityHint={open ? "Opens that Chat" : undefined}
          disabled={!open}
          onPress={open}
          hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
          style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Icon icon={CornerDownRightIcon} color={failed ? colors.red : colors.ink3} size={14} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: ink, fontSize: type.footnote, fontWeight: "500" }}>
            {marker.text}
          </Text>
        </Pressable>
        {hasBody && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? "Hide report" : "Show report"}
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((value) => !value)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 16 }}
          >
            <Icon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} color={ink} size={14} />
          </Pressable>
        )}
      </View>
      {expanded && hasBody && (
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: radius.card,
            borderCurve: "continuous",
            paddingVertical: 10,
            paddingHorizontal: 14,
          }}
        >
          <Markdown text={body} media={media} basePath={basePath} />
        </View>
      )}
    </View>
  );
}
