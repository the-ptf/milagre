import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  Alert02Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Moon02Icon,
  NextIcon,
  StopCircleIcon,
  UnavailableIcon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import type { RoutineRun } from "@milagre/shared/model";
import { attemptText, clock, daySummary, foldText, foldTimes, retryNote, runDays, runTitle, type RunEntry } from "@milagre/shared/routines";
import { Icon, SpinnerRing, type IconData, type Tone } from "./icons";
import { ChatMarkIcon } from "./status-indicators";
import { lineHeight, space, type } from "./design-tokens";
import { Group, PillButton, pressStyle, SectionLabel, useStyles } from "./ui";
import { useTheme } from "./theme";

const FIRST_DAYS = 4;
const MORE_DAYS = 7;

const firstLine = (text: string | undefined) =>
  text
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim();

function runLook(run: RoutineRun, routineName: string): { icon?: IconData; tone: Tone; text: string; failed?: boolean } {
  const note = retryNote(run);
  const noted = (text: string) => (note ? `${text} · ${note}` : text);
  if (run.status === "running") return { tone: "ink3", text: noted(runTitle(run, routineName)) };
  if (run.status === "failed") {
    const error = firstLine(run.error);
    return { icon: Alert02Icon, tone: "red", text: noted(error ? `Failed: ${error}` : "Failed"), failed: true };
  }
  if (run.status === "ended") {
    const reason = firstLine(run.error);
    return {
      icon: StopCircleIcon,
      tone: "ink3",
      text: noted(reason ? `${runTitle(run, routineName)}: ended, ${reason}` : `${runTitle(run, routineName)}: ended`),
    };
  }
  return { icon: CheckmarkCircle02Icon, tone: "ink3", text: noted(runTitle(run, routineName)) };
}

function foldedLine(run: RoutineRun): { icon: IconData; text: string } {
  if (run.rejected) return { icon: UnavailableIcon, text: firstLine(run.error) ?? "Refused" };
  if (run.status === "quiet") {
    const note = retryNote(run);
    const text = run.summary?.trim() || "Quiet";
    return { icon: Moon02Icon, text: note ? `${text} · ${note}` : text };
  }
  if (run.status === "skipped-busy") return { icon: NextIcon, text: "Its Chat was busy" };
  return { icon: Clock01Icon, text: "This computer missed its time" };
}

export function RunList({
  runs,
  routineName,
  now,
  unreadChats,
  canOpen,
  onOpenChat,
}: {
  runs: RoutineRun[];
  routineName: string;
  now: number;
  unreadChats: ReadonlySet<string>;
  canOpen: (chatKey: string) => boolean;
  onOpenChat: (chatKey: string) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const days = useMemo(() => runDays(runs, now), [runs, now]);
  const [shownDays, setShownDays] = useState(FIRST_DAYS);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const time = [styles.footnote, { fontVariant: ["tabular-nums" as const], width: 92, flexShrink: 0 }];
  const openable = (run: RoutineRun) => (run.chatId && canOpen(run.chatId) ? run.chatId : undefined);

  const row = ({
    key,
    when,
    icon,
    text,
    tone,
    muted,
    unread = false,
    trailing,
    onPress,
    expandedState,
  }: {
    key: string;
    when: string;
    icon: ReactNode;
    text: string;
    tone?: string;
    muted?: boolean;
    unread?: boolean;
    trailing?: IconData;
    onPress?: () => void;
    expandedState?: boolean;
  }) => (
    <Pressable
      key={key}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={[text, unread ? "Unread" : "", when].filter(Boolean).join(". ")}
      accessibilityState={expandedState === undefined ? undefined : { expanded: expandedState }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: space.lg, minHeight: 48, paddingVertical: space.md },
        pressStyle({ pressed, kind: "row" }),
      ]}
    >
      <Text numberOfLines={1} style={time}>
        {when}
      </Text>
      <View style={{ width: 20, alignItems: "center" }}>{icon}</View>
      <Text
        numberOfLines={1}
        style={[
          styles.text,
          {
            flex: 1,
            minWidth: 0,
            fontSize: type.subheadline,
            lineHeight: lineHeight.subheadline,
            fontWeight: muted ? "400" : "500",
            color: tone ?? (muted ? colors.ink2 : colors.ink),
          },
        ]}
      >
        {text}
      </Text>
      {unread ? (
        <View style={{ marginHorizontal: -6 }}>
          <ChatMarkIcon mark="unread" />
        </View>
      ) : null}
      {trailing ? <Icon icon={trailing} tone="ink3" size={16} /> : null}
    </Pressable>
  );

  const attempts = (run: RoutineRun) =>
    (run.attempts ?? []).map((attempt) => {
      const chat = attempt.chatId && canOpen(attempt.chatId) ? attempt.chatId : undefined;
      return row({
        key: `${run.id}:attempt:${attempt.endedAt}`,
        when: "",
        icon: <Icon icon={Alert02Icon} tone="ink3" size={16} />,
        text: attemptText(attempt),
        muted: true,
        trailing: chat ? ArrowRight01Icon : undefined,
        onPress: chat ? () => onOpenChat(chat) : undefined,
      });
    });

  const entry = (item: RunEntry) => {
    if (item.kind === "run") {
      const { run } = item;
      const look = runLook(run, routineName);
      const chat = openable(run);
      return [
        row({
          key: run.id,
          when: clock(run.startedAt),
          icon: look.icon ? <Icon icon={look.icon} tone={look.tone} size={16} /> : <SpinnerRing size={16} />,
          text: look.text,
          tone: look.failed ? colors.redInk : undefined,
          unread: chat !== undefined && unreadChats.has(chat),
          trailing: chat ? ArrowRight01Icon : undefined,
          onPress: chat ? () => onOpenChat(chat) : undefined,
        }),
        ...attempts(run),
      ];
    }
    const key = `fold:${item.runs[item.runs.length - 1]!.id}`;
    const open = expanded.has(key);
    return [
      row({
        key,
        when: foldTimes(item),
        icon: <Icon icon={item.counts.quiet ? Moon02Icon : item.counts.skipped ? NextIcon : Clock01Icon} tone="ink3" size={16} />,
        text: foldText(item),
        muted: true,
        trailing: open ? UnfoldLessIcon : UnfoldMoreIcon,
        onPress: () => toggle(key),
        expandedState: open,
      }),
      ...(open
        ? item.runs.flatMap((run) => {
            const line = foldedLine(run);
            const chat = run.status === "quiet" && !run.rejected ? openable(run) : undefined;
            return [
              row({
                key: run.id,
                when: clock(run.startedAt),
                icon: <Icon icon={line.icon} tone="ink3" size={16} />,
                text: line.text,
                muted: true,
                unread: chat !== undefined && unreadChats.has(chat),
                trailing: chat ? ArrowRight01Icon : undefined,
                onPress: chat ? () => onOpenChat(chat) : undefined,
              }),
              ...attempts(run),
            ];
          })
        : []),
    ];
  };

  return (
    <View style={{ gap: space.xl }}>
      {days.slice(0, shownDays).map((day) => {
        const open = day.recent || expanded.has(`day:${day.key}`);
        const rows = [
          ...(day.recent
            ? []
            : [
                row({
                  key: `day:${day.key}`,
                  when: "All day",
                  icon: <Icon icon={Calendar03Icon} tone="ink3" size={16} />,
                  text: daySummary(day.runs),
                  muted: true,
                  trailing: open ? UnfoldLessIcon : UnfoldMoreIcon,
                  onPress: () => toggle(`day:${day.key}`),
                  expandedState: open,
                }),
              ]),
          ...(open ? day.entries.flatMap(entry) : []),
        ];
        return (
          <View key={day.key} style={{ gap: space.md }}>
            <SectionLabel>{day.label}</SectionLabel>
            <Group inset={0}>{rows}</Group>
          </View>
        );
      })}
      {days.length > shownDays ? <PillButton title="Show earlier days" secondary onPress={() => setShownDays((count) => count + MORE_DAYS)} /> : null}
      <Text style={[styles.caption, { textAlign: "center" }]}>Keeps the newest 50 Runs that acted</Text>
    </View>
  );
}
