import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Alert02Icon, ArrowDown01Icon, ArrowRight01Icon, Clock01Icon, Moon02Icon, NextIcon, Tick02Icon, UnavailableIcon } from "@hugeicons/core-free-icons";
import type { RoutineRun } from "@milagre/shared/model";
import { foldRuns, foldText, runTitle, runWhen } from "@milagre/shared/routines";
import { Icon, SpinnerRing, type IconData, type Tone } from "./icons";
import { ChatMarkIcon } from "./status-indicators";
import { useStyles } from "./ui";
import { useTheme } from "./theme";

/** The first line of a Run's error that has something on it. */
const firstLine = (text: string | undefined) =>
  text
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim();

/** A Run that did something: its icon (none while it runs: a spinner), its tone, and a second line when it has one. */
function runLook(run: RoutineRun): { icon?: IconData; tone: Tone; detail?: string; failed?: boolean } {
  if (run.status === "running") return { tone: "ink3", detail: "Running" };
  if (run.status === "failed") {
    const error = firstLine(run.error);
    return { icon: Alert02Icon, tone: "red", detail: error ? `Failed · ${error}` : "Failed", failed: true };
  }
  return { icon: Tick02Icon, tone: "ink2" };
}

/** A folded Run as its line says it: a quiet one its summary, a skipped one that its Chat was busy, and so on. */
function foldedLine(run: RoutineRun): { icon: IconData; text: string } {
  if (run.rejected) return { icon: UnavailableIcon, text: firstLine(run.error) ?? "Refused" };
  if (run.status === "quiet") return { icon: Moon02Icon, text: run.summary?.trim() || "Quiet" };
  if (run.status === "skipped-busy") return { icon: NextIcon, text: "Its Chat was busy" };
  return { icon: Clock01Icon, text: "This Mac missed its time" };
}

/**
 * A Routine's Runs, newest first, in one card, as desktop's Runs list: a row for each Run that did something (running,
 * acted, failed) and one line for each stretch of Runs that didn't, which expands in place. A row, or a quiet Run's line,
 * opens the Run's Chat while that Chat is still there (`hasChat`, archived or not).
 */
export function RunList({
  runs,
  routineName,
  now,
  unreadChats,
  hasChat,
  onOpenChat,
}: {
  runs: RoutineRun[];
  routineName: string;
  now: number;
  /** The keys of hidden Run Chats nobody opened: their rows show the unread dot. */
  unreadChats: ReadonlySet<string>;
  /** Whether a Chat is still there to open, archived or not (chatLeft). */
  hasChat: (chatKey: string) => boolean;
  onOpenChat: (chatKey: string) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const entries = useMemo(() => foldRuns(runs), [runs]);
  // Open folds, by their oldest Run: new Runs join a stretch at its newest end, so the key holds while it grows.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const time = [styles.caption, { fontVariant: ["tabular-nums" as const] }];

  return (
    <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
      {entries.map((entry, index) => {
        const separator = index > 0 ? <View style={styles.separator} /> : null;
        if (entry.kind === "run") {
          const { run } = entry;
          const look = runLook(run);
          const title = runTitle(run, routineName);
          const when = runWhen(run.startedAt, now);
          // A Run whose Chat is gone opens nothing, rather than a Chat the Project no longer has.
          const chat = run.chatId && hasChat(run.chatId) ? run.chatId : undefined;
          const unread = chat !== undefined && unreadChats.has(chat);
          return (
            <View key={run.id}>
              {separator}
              <Pressable
                accessibilityRole={chat ? "button" : undefined}
                accessibilityLabel={[title, look.detail, unread ? "Unread" : "", when].filter(Boolean).join(". ")}
                disabled={!chat}
                onPress={chat ? () => onOpenChat(chat) : undefined}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  minHeight: 56,
                  paddingVertical: 10,
                  opacity: pressed ? 0.5 : 1,
                })}
              >
                <View style={{ width: 20, alignItems: "center" }}>
                  {look.icon ? <Icon icon={look.icon} tone={look.tone} size={18} /> : <SpinnerRing size={16} />}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text numberOfLines={1} style={[styles.text, { fontSize: 15, lineHeight: 20, fontWeight: "500" }]}>
                    {title}
                  </Text>
                  {look.detail ? (
                    <Text numberOfLines={2} style={[styles.caption, { color: look.failed ? colors.red : colors.ink2 }]}>
                      {look.detail}
                    </Text>
                  ) : null}
                </View>
                {unread ? <ChatMarkIcon mark="unread" /> : null}
                <Text style={time}>{when}</Text>
              </Pressable>
            </View>
          );
        }
        const key = entry.runs[entry.runs.length - 1]!.id;
        const open = expanded.has(key);
        const text = foldText(entry.counts, entry.last);
        return (
          <View key={`fold-${key}`}>
            {separator}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text}
              accessibilityState={{ expanded: open }}
              onPress={() => toggle(key)}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingVertical: 8, opacity: pressed ? 0.5 : 1 })}
            >
              <View style={{ width: 20, alignItems: "center" }}>
                <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={16} />
              </View>
              <Text numberOfLines={1} style={[styles.muted, { flex: 1, fontSize: 14 }]}>
                {text}
              </Text>
            </Pressable>
            {open ? (
              <View style={{ paddingBottom: 6 }}>
                {entry.runs.map((run) => {
                  const line = foldedLine(run);
                  const when = runWhen(run.startedAt, now);
                  const chat = run.status === "quiet" && !run.rejected && run.chatId && hasChat(run.chatId) ? run.chatId : undefined;
                  return (
                    <Pressable
                      key={run.id}
                      accessibilityRole={chat ? "button" : undefined}
                      accessibilityLabel={`${line.text}. ${when}`}
                      disabled={!chat}
                      onPress={chat ? () => onOpenChat(chat) : undefined}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 10,
                        minHeight: 36,
                        paddingVertical: 6,
                        paddingLeft: 32,
                        opacity: pressed ? 0.5 : 1,
                      })}
                    >
                      <Icon icon={line.icon} tone="ink3" size={15} />
                      <Text numberOfLines={2} style={[styles.caption, { flex: 1, color: colors.ink2, fontSize: 13 }]}>
                        {line.text}
                      </Text>
                      <Text style={time}>{when}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
