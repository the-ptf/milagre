import { Text } from "react-native";
import { ArrowRight01Icon, Link04Icon } from "@hugeicons/core-free-icons";
import type { linkedLine } from "@milagre/shared/linked-message";
import { lineHeight, type } from "./design-tokens";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { TranscriptDivider } from "./ui";

export function LinkedMessageLine({
  line,
  count,
  attachments = 0,
  onOpen,
}: {
  line: NonNullable<ReturnType<typeof linkedLine>>;
  count?: number;
  attachments?: number;
  onOpen: () => void;
}) {
  const { colors } = useTheme();
  const caption = { color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 };
  const verb = count ? `${count} messages with` : line.verb;
  return (
    <TranscriptDivider label={`${verb} ${line.label}`} icon={Link04Icon} onPress={onOpen} hint={count ? "Opens the exchange" : "Opens the message"}>
      <Text style={caption}>{verb}</Text>
      <Text numberOfLines={1} style={[caption, { flexShrink: 1, color: colors.ink2, fontWeight: "500" }]}>
        {line.name}
      </Text>
      {attachments > 0 && <Text style={caption}>· {attachments === 1 ? "1 attachment" : `${attachments} attachments`}</Text>}
      <Icon icon={ArrowRight01Icon} tone="ink3" size={12} />
    </TranscriptDivider>
  );
}
