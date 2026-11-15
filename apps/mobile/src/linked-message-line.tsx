import { Text } from "react-native";
import { ArrowRight01Icon, Link04Icon } from "@hugeicons/core-free-icons";
import type { linkedLine } from "@milagre/shared/linked-message";
import { lineHeight, type } from "./design-tokens";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { TranscriptDivider } from "./ui";

/**
 * A message another Chat's agent sent here (chat_start, or a Delegation), as one line between rules, the way a model
 * switch is one: "Message from Fix login ›". Tapping it opens the whole message in a sheet.
 */
export function LinkedMessageLine({
  line,
  attachments = 0,
  onOpen,
}: {
  line: NonNullable<ReturnType<typeof linkedLine>>;
  attachments?: number;
  onOpen: () => void;
}) {
  const { colors } = useTheme();
  const caption = { color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 };
  return (
    <TranscriptDivider label={`${line.verb} ${line.label}`} icon={Link04Icon} onPress={onOpen} hint="Opens the message">
      <Text style={caption}>{line.verb}</Text>
      <Text numberOfLines={1} style={[caption, { flexShrink: 1, color: colors.ink2, fontWeight: "500" }]}>
        {line.name}
      </Text>
      {attachments > 0 && <Text style={caption}>· {attachments === 1 ? "1 attachment" : `${attachments} attachments`}</Text>}
      <Icon icon={ArrowRight01Icon} tone="ink3" size={12} />
    </TranscriptDivider>
  );
}
