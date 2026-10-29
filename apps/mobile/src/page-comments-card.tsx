import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { CheckmarkCircle02Icon, Comment01Icon } from "@hugeicons/core-free-icons";
import type { ParsedPageComment, SavedPageComment } from "@milagre/shared/page-comments";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { Icon } from "./icons";
import { radius, type } from "./design-tokens";

/**
 * Comments sent from a Browser panel page (desktop or this phone), shown as what they were instead of the text the agent
 * reads: each comment with the element it is on, and the agent's note once it resolved it.
 */
export function PageCommentsCard({ comments, chatId, moved = 0 }: { comments: ParsedPageComment[]; chatId?: string; moved?: number }) {
  const { colors } = useTheme();
  const { client } = useSession();
  const [notes, setNotes] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (!client || !chatId) return;
    let live = true;
    client
      .call<SavedPageComment[]>("browser-comments:list", [{ chatId }])
      .then((saved) => live && setNotes(new Map(saved.flatMap((item) => (item.resolved ? [[item.id, item.resolved.note] as [string, string]] : [])))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, chatId, moved]);
  const titles = [...new Set(comments.map((comment) => comment.title || comment.url))];
  const label = `${comments.length === 1 ? "A comment" : `${comments.length} comments`} on ${titles.length === 1 ? titles[0] : `${titles.length} pages`}`;
  return (
    <View
      accessibilityLabel={label}
      style={{
        minWidth: 240,
        borderRadius: radius.card,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: colors.surface,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderColor: colors.line,
        }}
      >
        <Icon icon={Comment01Icon} tone="ink2" size={14} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontSize: type.caption1 }}>
          {label}
        </Text>
      </View>
      {comments.map((comment) => {
        const note = notes.get(comment.id);
        return (
          <View
            key={comment.id}
            style={{ flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderColor: colors.line }}
          >
            {note ? (
              <Icon icon={CheckmarkCircle02Icon} tone="green" size={16} />
            ) : (
              <Text style={{ width: 16, color: colors.accent, fontSize: type.footnote, fontWeight: "600", textAlign: "center" }}>{comment.number}</Text>
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <Text selectable numberOfLines={8} style={{ color: colors.ink, fontSize: type.subheadline }}>
                {comment.text}
              </Text>
              <Text numberOfLines={2} style={{ color: note ? colors.green : colors.ink3, fontSize: type.caption1 }}>
                {note ? `Resolved · ${note}` : `${comment.label} · not resolved yet`}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}
