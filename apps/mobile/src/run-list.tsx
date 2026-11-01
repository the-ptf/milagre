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
  UnavailableIcon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import type { RoutineRun } from "@milagre/shared/model";
import { attemptText, clock, daySummary, foldText, foldTimes, retryNote, runDays, runTitle, type RunEntry } from "@milagre/shared/routines";
import { Icon, SpinnerRing, type IconData, type Tone } from "./icons";
import { ChatMarkIcon } from "./status-indicators";
import { Button, useStyles } from "./ui";
import { useTheme } from "./theme";

/** Day groups shown at first, and how many more each Show earlier days adds, as on desktop. */
const FIRST_DAYS = 4;
const MORE_DAYS = 7;

/** The first line of a Run's error that has something on it. */
const firstLine = (text: string | undefined) =>
  text
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim();

/** A Run that did something: its icon (none while it runs: a spinner), its tone, and its words (a failed one says why). */
function runLook(run: RoutineRun, routineName: string): { icon?: IconData; tone: Tone; text: string; failed?: boolean } {
  // A Run that ran on its fallback says so after its words, as on desktop.
  const note = retryNote(run);
  const noted = (text: string) => (note ? `${text} · ${note}` : text);
  if (run.status === "running") return { tone: "ink3", text: noted(runTitle(run, routineName)) };
  if (run.status === "failed") {
    const error = firstLine(run.error);
    return { icon: Alert02Icon, tone: "red", text: noted(error ? `Failed: ${error}` : "Failed"), failed: true };
  }
  return { icon: CheckmarkCircle02Icon, tone: "ink3", text: noted(runTitle(run, routineName)) };
}

/** A folded Run as its line says it: a quiet one its summary, a skipped one that its Chat was busy, and so on. */
function foldedLine(run: RoutineRun): { icon: IconData; text: string } {
  if (run.rejected) return { icon: UnavailableIcon, text: firstLine(run.error) ?? "Refused" };
  if (run.status === "quiet") {
    const note = retryNote(run);
    const text = run.summary?.trim() || "Quiet";
    return { icon: Moon02Icon, text: note ? `${text} · ${note}` : text };
  }
  if (run.status === "skipped-busy") return { icon: NextIcon, text: "Its Chat was busy" };
  return { icon: Clock01Icon, text: "This Mac missed its time" };
}

/**
 * A Routine's Runs, newest first, by day as desktop's Runs log: a small heading per day (Today, Yesterday, Thu, Oct 16) over
 * a card of rows. A Run that did something has a row; a stretch of Runs that didn't folds into one line that expands in
 * place; a day before yesterday is one summary line until opened. Show earlier days adds days. A row opens the Run's Chat
 * when `canOpen` says it can (canOpenRunChat: still there, archived or not, or in a Project not held).
 */
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
  /** The keys of hidden Run Chats nobody opened: their rows show the unread dot. */
  unreadChats: ReadonlySet<string>;
  /** Whether a Run's Chat can be opened (canOpenRunChat). */
  canOpen: (chatKey: string) => boolean;
  onOpenChat: (chatKey: string) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const days = useMemo(() => runDays(runs, now), [runs, now]);
  const [shownDays, setShownDays] = useState(FIRST_DAYS);
  // Open folds by their oldest Run (new Runs join a stretch at its newest end, so the key holds while it grows), and open
  // older days by their key.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // The time keeps its width, wide enough for a fold's range ("13:29–13:30") on one line; the words give way first.
  const time = [styles.caption, { fontVariant: ["tabular-nums" as const], width: 92, flexShrink: 0, fontSize: 13 }];
  const openable = (run: RoutineRun) => (run.chatId && canOpen(run.chatId) ? run.chatId : undefined);

  /** One row: the time column, an icon, the words, then the unread dot and a chevron when it opens a Chat. */
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
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingVertical: 8, opacity: pressed ? 0.5 : 1 })}
    >
      <Text numberOfLines={1} style={time}>
        {when}
      </Text>
      <View style={{ width: 20, alignItems: "center" }}>{icon}</View>
      {/* The words take all the room the others leave, and truncate only where they meet them. */}
      <Text
        numberOfLines={1}
        style={[
          styles.text,
          { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, fontWeight: muted ? "400" : "500", color: tone ?? (muted ? colors.ink2 : colors.ink) },
        ]}
      >
        {text}
      </Text>
      {/* The mark is a 20 pt box round an 8 pt dot: its 6 pt of padding each side is not the words' to give up. */}
      {unread ? (
        <View style={{ marginHorizontal: -6 }}>
          <ChatMarkIcon mark="unread" />
        </View>
      ) : null}
      {trailing ? <Icon icon={trailing} tone="ink3" size={16} /> : null}
    </Pressable>
  );

  // The attempts a Run retried after: a muted line each, under it, that opens its own Chat while it is there.
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
      // A Run whose Chat is gone opens nothing, rather than a Chat the Project no longer has.
      const chat = openable(run);
      return [
        row({
          key: run.id,
          when: clock(run.startedAt),
          icon: look.icon ? <Icon icon={look.icon} tone={look.tone} size={18} /> : <SpinnerRing size={16} />,
          text: look.text,
          tone: look.failed ? colors.red : undefined,
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
        icon: <Icon icon={item.counts.quiet ? Moon02Icon : item.counts.skipped ? NextIcon : Clock01Icon} tone="ink3" size={17} />,
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
    <View style={{ gap: 14 }}>
      {days.slice(0, shownDays).map((day) => {
        const open = day.recent || expanded.has(`day:${day.key}`);
        const rows = [
          ...(day.recent
            ? []
            : [
                row({
                  key: `day:${day.key}`,
                  when: "All day",
                  icon: <Icon icon={Calendar03Icon} tone="ink3" size={17} />,
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
          <View key={day.key} style={{ gap: 6 }}>
            <Text accessibilityRole="header" style={[styles.section, { paddingHorizontal: 4 }]}>
              {day.label}
            </Text>
            <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
              {rows.map((child, index) => (
                <View key={child.key ?? index}>
                  {index > 0 ? <View style={styles.separator} /> : null}
                  {child}
                </View>
              ))}
            </View>
          </View>
        );
      })}
      {days.length > shownDays ? <Button title="Show earlier days" secondary onPress={() => setShownDays((count) => count + MORE_DAYS)} /> : null}
      <Text style={[styles.caption, { textAlign: "center" }]}>Keeps the newest 50 Runs that acted</Text>
    </View>
  );
}
