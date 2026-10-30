import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type DimensionValue } from "react-native";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Mic01Icon,
  BrainIcon,
  File01Icon,
  GitPullRequestIcon,
  Search01Icon,
  Tick02Icon,
  CommandLineIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { ChatRowShow } from "@milagre/shared/chat-row";
import { Icon } from "./icons";
import { tap } from "./primitives/tap";
import { createStylesHook, fonts, type Palette } from "./theme";
import { useTheme } from "./theme";
import { radius, type } from "./design-tokens";

/** One choice of a setting shown as a card: a small sketch of what it looks like, its name and a line about it. */
export type VisualChoice<T extends string> = { value: T; title: string; description: string; preview: ReactNode };

/** Two or more settings choices side by side, each a card with its sketch; the chosen one is outlined in the accent. */
export function ChoiceCards<T extends string>({
  label,
  value,
  options,
  onChange,
  compact = false,
}: {
  label: string;
  value: T;
  options: VisualChoice<T>[];
  onChange: (value: T) => void;
  compact?: boolean;
}) {
  const s = useS();
  const { colors } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={[s.cards, compact && { gap: 8 }]}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={`${option.title}. ${option.description}`}
            accessibilityState={{ checked: selected }}
            onPress={() => {
              if (selected) return;
              tap();
              onChange(option.value);
            }}
            style={({ pressed }) => [
              s.card,
              compact && { padding: 8, gap: 8, borderRadius: radius.card, borderWidth: 2, minWidth: 0 },
              selected ? { borderColor: colors.accent, borderWidth: 2 } : null,
              { opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[s.preview, compact && { minHeight: 64, height: 64, padding: 8, borderRadius: radius.chip }]}
            >
              {option.preview}
            </View>
            <View style={s.name}>
              {selected ? (
                <View style={[s.mark, { backgroundColor: colors.accent }]}>
                  <Icon icon={Tick02Icon} tone="onAccent" size={12} />
                </View>
              ) : (
                <View style={[s.mark, { borderWidth: 1.5, borderColor: colors.ink3 }]} />
              )}
              <Text numberOfLines={compact ? undefined : 1} style={s.title}>
                {option.title}
              </Text>
            </View>
            <Text style={[s.description, compact && { fontSize: type.footnote }]}>{option.description}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A transcript waiting at the caret, or already sent with an empty composer below it. */
export function DictationPreview({ sent = false }: { sent?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, justifyContent: "center", gap: 4 }}>
      <View style={{ alignSelf: "flex-end", width: "60%", height: 10, borderRadius: radius.chip, borderCurve: "continuous", backgroundColor: colors.line }} />
      {sent && (
        <View style={{ alignSelf: "flex-end", width: "72%", height: 10, borderRadius: radius.chip, borderCurve: "continuous", backgroundColor: colors.ink4 }} />
      )}
      <View
        style={{
          height: sent ? 18 : 26,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 6,
          borderRadius: radius.full,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.lineStrong,
          backgroundColor: colors.surface,
        }}
      >
        {!sent && (
          <>
            <View style={{ flex: 1, height: 4, backgroundColor: colors.ink4, borderRadius: radius.full, borderCurve: "continuous" }} />
            <View style={{ width: 2, height: 14, backgroundColor: colors.accent }} />
          </>
        )}
        {sent ? (
          <View style={{ marginLeft: "auto" }}>
            <Icon icon={Mic01Icon} size={12} tone="ink3" />
          </View>
        ) : (
          <View
            style={{
              marginLeft: 4,
              width: 20,
              height: 20,
              borderRadius: radius.full,
              borderCurve: "continuous",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.ink,
            }}
          >
            <Icon icon={ArrowUp01Icon} size={12} tone="onInk" />
          </View>
        )}
      </View>
    </View>
  );
}

function Bar({ width, height = 6, strong = false }: { width: DimensionValue; height?: number; strong?: boolean }) {
  const { colors } = useTheme();
  return <View style={{ width, height, borderRadius: height / 2, backgroundColor: strong ? colors.lineStrong : colors.line }} />;
}

function Square({ color, size = 6 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: 2, backgroundColor: color }} />;
}

/** One list: every Chat newest first, its Project on a small first line. */
export function OneListPreview() {
  const { colors } = useTheme();
  const rows: [string, DimensionValue, DimensionValue][] = [
    [colors.ink3, "85%", "62%"],
    [colors.orange, "74%", "54%"],
    [colors.purple, "90%", "50%"],
    [colors.ink3, "68%", "58%"],
  ];
  return (
    <View style={{ gap: 11 }}>
      {rows.map(([color, title, meta], index) => (
        <View key={index} style={{ gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            <Square color={color} size={5} />
            <Bar width="26%" height={5} />
          </View>
          <Bar width={title} height={7} strong />
          <Bar width={meta} height={4} />
        </View>
      ))}
    </View>
  );
}

/** By Project: a group per Project with its Chats under it; the last group folded. */
export function ByProjectPreview() {
  const { colors } = useTheme();
  const group = (color: string, width: DimensionValue) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Square color={color} size={8} />
      <Bar width={width} height={7} strong />
    </View>
  );
  const chat = (title: DimensionValue, meta: DimensionValue) => (
    <View style={{ gap: 3, paddingLeft: 12 }}>
      <Bar width={title} height={6} />
      <Bar width={meta} height={4} />
    </View>
  );
  return (
    <View style={{ gap: 8 }}>
      {group(colors.ink3, "40%")}
      {chat("72%", "46%")}
      {chat("62%", "40%")}
      <View style={{ height: 2 }} />
      {group(colors.orange, "34%")}
      {chat("68%", "38%")}
      <View style={{ height: 2 }} />
      {group(colors.purple, "30%")}
    </View>
  );
}

function ReplyLine({ icon, text, open }: { icon: typeof BrainIcon; text: string; open?: boolean }) {
  const s = useS();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <Icon icon={icon} tone="ink3" size={11} />
      <Text numberOfLines={1} style={s.tiny}>
        {text}
      </Text>
      {open !== undefined && <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={10} />}
    </View>
  );
}

function Answer({ widths }: { widths: DimensionValue[] }) {
  return (
    <View style={{ gap: 7 }}>
      {widths.map((width, index) => (
        <Bar key={index} width={width} strong />
      ))}
    </View>
  );
}

/** Reasoning folded: one "Thought for 12s" row above the answer. */
export function FoldedReasoningPreview() {
  return (
    <View style={{ gap: 9 }}>
      <ReplyLine icon={BrainIcon} text="Thought for 12s" open={false} />
      <Answer widths={["95%", "84%", "90%", "52%"]} />
    </View>
  );
}

/** Reasoning expanded: the thinking open under its row, ruled at the left, then the answer. */
export function ExpandedReasoningPreview() {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 9 }}>
      <ReplyLine icon={BrainIcon} text="Thinking" open />
      <View style={{ flexDirection: "row", gap: 6 }}>
        <View style={{ width: 2, borderRadius: 1, backgroundColor: colors.lineStrong }} />
        <View style={{ flex: 1, gap: 5 }}>
          <Bar width="88%" height={5} />
          <Bar width="76%" height={5} />
          <Bar width="58%" height={5} />
        </View>
      </View>
      <Answer widths={["95%", "62%"]} />
    </View>
  );
}

/** Tool calls compact: one line per reply. */
export function CompactToolsPreview() {
  return (
    <View style={{ gap: 9 }}>
      <ReplyLine icon={Wrench01Icon} text="Read 4 files, ran 2" open={false} />
      <Answer widths={["95%", "84%", "90%", "52%"]} />
    </View>
  );
}

/** Tool calls in full detail: each call on its own row. */
export function FullToolsPreview() {
  return (
    <View style={{ gap: 7 }}>
      <ReplyLine icon={File01Icon} text="Read chat.tsx" />
      <ReplyLine icon={Search01Icon} text="Searched “enter(”" />
      <ReplyLine icon={CommandLineIcon} text="Ran npm test" />
      <View style={{ height: 2 }} />
      <Answer widths={["95%", "64%"]} />
    </View>
  );
}

/** A sample Chat row as the list draws it with `show`, above the switches that change it. */
export function SampleChatRow({ show }: { show: ChatRowShow }) {
  const s = useS();
  const { colors } = useTheme();
  return (
    <View accessible accessibilityLabel="Sample Chat row" style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Square color={colors.ink3} size={14} />
        <Text style={[s.small, { flex: 1, color: colors.ink2 }]}>milagre-ade</Text>
        {show.lastActivity && <Text style={[s.small, { color: colors.ink3, fontVariant: ["tabular-nums"] }]}>4m</Text>}
      </View>
      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 16, fontWeight: "500" }}>
        App freezes when opening chats
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {show.branch && <Text style={[s.small, { color: colors.ink3, fontFamily: fonts.mono }]}>milagre/fix-chat</Text>}
        {show.pullRequests && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            <Icon icon={GitPullRequestIcon} tone="purple" size={12} />
            <Text style={[s.small, { color: colors.purple }]}>#649</Text>
          </View>
        )}
        {show.linearIssue && <Text style={[s.small, { color: colors.ink2 }]}>ENG-412</Text>}
        {show.diff && (
          <Text style={[s.small, { fontVariant: ["tabular-nums"] }]}>
            <Text style={{ color: colors.add }}>+120</Text> <Text style={{ color: colors.remove }}>−8</Text>
          </Text>
        )}
      </View>
    </View>
  );
}

const useS = createStylesHook((colors: Palette) =>
  StyleSheet.create({
    cards: { flexDirection: "row", gap: 12 },
    card: {
      flex: 1,
      gap: 10,
      padding: 12,
      borderRadius: 16,
      borderCurve: "continuous",
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    preview: { minHeight: 104, padding: 10, borderRadius: 10, borderCurve: "continuous", backgroundColor: colors.page, overflow: "hidden" },
    name: { flexDirection: "row", alignItems: "center", gap: 6 },
    mark: { width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center" },
    title: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: "600" },
    description: { color: colors.ink3, fontSize: 12, lineHeight: 16 },
    tiny: { flexShrink: 1, color: colors.ink3, fontSize: 9 },
    small: { fontSize: 12 },
  }),
);
