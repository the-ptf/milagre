import { Pressable, Text, View } from "react-native";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import type { QueuedMessage } from "@milagre/shared/model";
import { queueStatus } from "@milagre/shared/queued-messages";
import { hitSlopFor, lineHeight, radius, space, type } from "./design-tokens";
import { useTheme } from "./theme";
import { IconButton, pressStyle, tap, useStyles } from "./ui";

/**
 * Messages waiting for the running turn of an agent that can't be steered, above the composer like desktop's: oldest
 * first, each with Send now (Stop and send while a turn runs) and Remove. The line above says when they go.
 */
export function QueuedMessages({
  items,
  held,
  running,
  disabled,
  onSendNow,
  onRemove,
}: {
  items: QueuedMessage[];
  held: boolean;
  running: boolean;
  disabled: boolean;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  if (!items.length) return null;
  return (
    <View
      accessibilityLabel="Queued messages"
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.sheet,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.lineStrong,
        paddingHorizontal: space.xl,
        paddingTop: space.lg,
        paddingBottom: space.xs,
      }}
    >
      <Text style={styles.caption}>
        <Text style={{ color: colors.ink2, fontWeight: "600" }}>Queued</Text> · {queueStatus({ count: items.length, held, running })}
      </Text>
      {items.map((item) => (
        <View key={item.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 }}>
          <Text numberOfLines={2} style={{ flex: 1, color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
            {item.body.trim() || "Attachments"}
            {attachmentNote(item) ? <Text style={{ color: colors.ink3 }}> · {attachmentNote(item)}</Text> : null}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={running ? "Stop and send" : "Send now"}
            accessibilityState={{ disabled }}
            disabled={disabled}
            hitSlop={hitSlopFor(32)}
            onPress={() => {
              tap();
              onSendNow(item.id);
            }}
            style={({ pressed }) => [{ paddingHorizontal: space.md, paddingVertical: space.sm }, pressStyle({ pressed, disabled })]}
          >
            <Text style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>
              {running ? "Stop and send" : "Send now"}
            </Text>
          </Pressable>
          <IconButton label="Remove from queue" icon={Cancel01Icon} size={32} disabled={disabled} onPress={() => onRemove(item.id)} />
        </View>
      ))}
    </View>
  );
}

function attachmentNote(item: QueuedMessage) {
  const images = item.images?.length ?? 0;
  const files = item.files?.length ?? 0;
  return [images ? `${images} image${images === 1 ? "" : "s"}` : "", files ? `${files} file${files === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
}
