import { Pressable, Text, View } from "react-native";
import { BubbleChatIcon, File01Icon, Folder01Icon, Image01Icon, MagicWand01Icon, ReactIcon } from "@hugeicons/core-free-icons";
import { fileKind } from "@milagre/shared/file-kinds";
import { imageLabel, skillLabel } from "@milagre/shared/prompt-parts";
import { withAlpha } from "@milagre/shared/themes";
import { Icon } from "./icons";
import { useTheme } from "./theme";

// An inline View in Text sits with its bottom on the text baseline, so both chips share one box (`chipBox`) and one
// shift down (`chipShift`) that centres it on the line, however the label or icon inside it is made.
const chipBox = (px: number) => ({ height: Math.round(px * 1.35), paddingHorizontal: 6, borderRadius: 6, borderWidth: 1 });
const chipShift = (px: number) => Math.round(px * 0.3);

function Box({
  px,
  color,
  fill,
  children,
  onPress,
  label,
}: {
  px: number;
  color: string;
  fill: string;
  children: React.ReactNode;
  onPress?: () => void;
  label?: string;
}) {
  const style = {
    ...chipBox(px),
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    borderColor: color,
    backgroundColor: fill,
    transform: [{ translateY: chipShift(px) }],
    maxWidth: px * 16,
  };
  if (onPress)
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={style}>
        {children}
      </Pressable>
    );
  return <View style={style}>{children}</View>;
}

/** A skill in a sent prompt: a wand and its name title-cased. */
export function SkillChip({ name }: { name: string }) {
  const { colors, textPx } = useTheme();
  return (
    <Box px={textPx} color={withAlpha(colors.accent, 0.4)} fill={colors.accentTint}>
      <Icon icon={MagicWand01Icon} size={Math.round(textPx * 0.95)} color={colors.accentInk} />
      <Text numberOfLines={1} style={{ color: colors.accentInk, fontSize: textPx, lineHeight: Math.round(textPx * 1.2) }}>
        {skillLabel(name)}
      </Text>
    </Box>
  );
}

function KindIcon({ path, size }: { path: string; size: number }) {
  const kind = fileKind(path);
  if (kind.badge)
    return (
      <View style={{ borderRadius: 3, paddingHorizontal: 3, backgroundColor: withAlpha(kind.color, 0.16) }}>
        <Text style={{ color: kind.color, fontSize: Math.round(size * 0.62), lineHeight: Math.round(size * 0.9), fontWeight: "700" }}>{kind.badge}</Text>
      </View>
    );
  const icon = kind.icon === "react" ? ReactIcon : kind.icon === "image" ? Image01Icon : kind.icon === "folder" ? Folder01Icon : File01Icon;
  return <Icon icon={icon} color={kind.color} size={Math.round(size * 0.95)} strokeWidth={1.8} />;
}

/** A file in a sent prompt: its type and name; a tap opens the preview when `onOpen` is given. */
export function FileMentionChip({ path, onOpen }: { path: string; onOpen?: () => void }) {
  const { colors, textPx } = useTheme();
  const name = path.split("/").findLast(Boolean) ?? path;
  return (
    <Box px={textPx} color={colors.lineStrong} fill={colors.hover} onPress={onOpen} label={`Preview ${name}`}>
      <KindIcon path={path} size={textPx} />
      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: textPx, lineHeight: Math.round(textPx * 1.2), flexShrink: 1 }}>
        {name}
      </Text>
    </Box>
  );
}

/** An inline image position (`[Image #1]`) in a sent prompt; a tap opens the photo viewer when `onOpen` is given. */
export function ImageMentionChip({ index, onOpen }: { index: number; onOpen?: () => void }) {
  const { colors, textPx } = useTheme();
  const label = imageLabel(index);
  return (
    <Box px={textPx} color={colors.lineStrong} fill={colors.hover} onPress={onOpen} label={`Preview ${label}`}>
      <Icon icon={Image01Icon} color="#26a69a" size={Math.round(textPx * 0.95)} strokeWidth={1.8} />
      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: textPx, lineHeight: Math.round(textPx * 1.2), flexShrink: 1 }}>
        {label}
      </Text>
    </Box>
  );
}

/** A mentioned Chat opens through the same scoped navigation as a sender line. */
export function ChatMentionChip({ title, onOpen }: { title: string; onOpen?: () => void }) {
  const { colors, textPx } = useTheme();
  return (
    <Box px={textPx} color={colors.lineStrong} fill={colors.hover} onPress={onOpen} label={`Open ${title}`}>
      <Icon icon={BubbleChatIcon} size={Math.round(textPx * 0.95)} color={colors.ink2} />
      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: textPx, lineHeight: Math.round(textPx * 1.2), flexShrink: 1 }}>
        {title}
      </Text>
    </Box>
  );
}
