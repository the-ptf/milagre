import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  CLEANUP_INTRO,
  CLEANUP_TITLE,
  IDLE_DAYS,
  SAVED_GROUP,
  UNSAVED_GROUP,
  cleanupGroups,
  cleanupToast,
  groupLine,
  idleFor,
  progressLine,
  removeIdleWorktrees,
  removeLabel,
  rowDate,
  rowDetail,
  rowSize,
  selectionLine,
  type IdleDays,
  type IdleWorktree,
  type IdleWorktrees,
} from "@milagre/shared/storage";
import { createClient } from "../../client";
import { relayRuntime } from "../../relay-native";
import { useSession } from "../../session";
import { Group } from "../../settings-list";
import { CheckRow } from "../../primitives/check-row";
import { Toast } from "../../primitives/toast";
import { ErrorNotice, PageScroll, PillButton, Segmented, useStyles } from "../../ui";
import { useTheme } from "../../theme";
import { radius, type } from "../../design-tokens";

const DAY_OPTIONS = IDLE_DAYS.map((days) => ({ value: String(days), title: `${days} days` }));
const olderMilagre = (error: string) => /unknown|not (available|allowed|supported)|no handler/i.test(error);
const savedPaths = (list: readonly IdleWorktree[], days: IdleDays, now: number) =>
  new Set(cleanupGroups(idleFor(list, days, now)).saved.map((item) => item.path));

function confirmRemove(count: number, onConfirm: () => void) {
  const label = removeLabel(count);
  if (Platform.OS === "ios")
    ActionSheetIOS.showActionSheetWithOptions(
      { title: CLEANUP_INTRO, options: [label, "Cancel"], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      (index) => {
        if (index === 0) onConfirm();
      },
    );
  else
    Alert.alert(label, CLEANUP_INTRO, [
      { text: "Cancel", style: "cancel" },
      { text: label, style: "destructive", onPress: onConfirm },
    ]);
}

/**
 * Settings › Computers › a computer › What Milagre uses › Clean up worktrees: that computer's worktrees no Chat has used
 * for 30, 60 or 90 days, those with nothing unsaved picked at first. Removing goes one at a time with progress and Stop,
 * then the list reads again.
 */
export default function ComputerCleanupScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const host = session.hosts.find((saved) => saved.id === id);
  const client = useMemo(() => (host ? createClient(host, fetch, 5000, relayRuntime) : null), [host]);
  // The list with the time it was read, so "unused for" counts from that read.
  const [read, setRead] = useState<{ list: IdleWorktree[]; at: number } | null>(null);
  const list = read?.list ?? null;
  const now = read?.at ?? 0;
  const [error, setError] = useState("");
  const [days, setDays] = useState<IdleDays>(30);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<number | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const toasts = useRef(0);
  const stop = useRef(false);
  const [stopping, setStopping] = useState(false);

  const load = useCallback(
    (span: IdleDays) =>
      client?.call<IdleWorktrees>("storage:worktrees", []).then(
        (answer) => {
          const at = Date.now();
          setRead({ list: answer.worktrees, at });
          setSelected(savedPaths(answer.worktrees, span, at));
          setError("");
        },
        (failure: Error) => setError(failure.message),
      ),
    [client],
  );
  useEffect(() => {
    void load(30);
  }, [load]);

  const visible = useMemo(() => (list ? idleFor(list, days, now) : []), [list, days, now]);
  const groups = useMemo(() => cleanupGroups(visible), [visible]);
  const chosen = visible.filter((item) => selected.has(item.path));
  const busy = progress !== null;

  const toggle = (paths: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const path of paths) {
        if (on) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  const groupRow = (title: string, items: IdleWorktree[]) => {
    const all = items.length > 0 && items.every((item) => selected.has(item.path));
    return (
      <CheckRow
        key={title}
        kind="checkbox"
        title={title}
        subtitle={groupLine(items)}
        checked={all}
        accessory={title === UNSAVED_GROUP ? <View style={{ width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.orange }} /> : undefined}
        disabled={busy || !items.length}
        onPress={() =>
          toggle(
            items.map((item) => item.path),
            !all,
          )
        }
      />
    );
  };

  async function remove() {
    if (!client || busy || !chosen.length) return;
    stop.current = false;
    setStopping(false);
    setProgress(0);
    const result = await removeIdleWorktrees(chosen, (request) => client.call("storage:remove-worktree", [request]), {
      onProgress: setProgress,
      stopped: () => stop.current,
    });
    toasts.current += 1;
    setToast({ key: toasts.current, text: cleanupToast(result) });
    void client.call("computer:resources:read", [{ fresh: true }]).catch(() => {});
    setProgress(null);
    await load(days);
  }

  return (
    <>
      <Stack.Screen options={{ title: CLEANUP_TITLE }} />
      <PageScroll>
        <View style={{ gap: 22 }}>
          <Text style={{ color: colors.ink2, fontSize: type.subheadline }}>{CLEANUP_INTRO}</Text>
          <Segmented
            label="Unused for at least"
            value={String(days)}
            options={DAY_OPTIONS}
            onChange={(value) => {
              if (busy) return;
              const span = Number(value) as IdleDays;
              setDays(span);
              setSelected(savedPaths(list ?? [], span, now));
            }}
          />
          {error ? (
            <ErrorNotice
              message={
                olderMilagre(error)
                  ? `Milagre on ${host?.name ?? "this computer"} can't clean up worktrees yet. Update it first.`
                  : `Couldn't list the worktrees: ${error}`
              }
            />
          ) : list === null ? (
            <ActivityIndicator color={colors.ink3} style={{ marginTop: 24 }} />
          ) : !visible.length ? (
            <Text style={{ color: colors.ink3, fontSize: type.subheadline, paddingVertical: 16, textAlign: "center" }}>
              No worktree has gone unused for {days} days.
            </Text>
          ) : (
            <>
              <Group inset={0}>{[groupRow(SAVED_GROUP, groups.saved), groupRow(UNSAVED_GROUP, groups.unsaved)]}</Group>
              <Group inset={0}>
                {[...groups.saved, ...groups.unsaved].map((item) => (
                  <CheckRow
                    key={item.path}
                    kind="checkbox"
                    title={item.title}
                    subtitle={`${rowDetail(item)}\n${rowDate(item.lastAt, now)} · ${rowSize(item)}`}
                    checked={selected.has(item.path)}
                    disabled={busy}
                    onPress={() => toggle([item.path], !selected.has(item.path))}
                  />
                ))}
              </Group>
              <Text style={styles.caption}>{busy ? progressLine(progress, chosen.length) : selectionLine(chosen)}</Text>
              {busy ? (
                <PillButton
                  title={stopping ? "Stopping…" : "Stop"}
                  variant="secondary"
                  disabled={stopping}
                  onPress={() => {
                    stop.current = true;
                    setStopping(true);
                  }}
                />
              ) : (
                <PillButton
                  title={removeLabel(chosen.length)}
                  variant="primary"
                  destructive
                  disabled={!chosen.length}
                  onPress={() => confirmRemove(chosen.length, () => void remove())}
                />
              )}
            </>
          )}
        </View>
      </PageScroll>
      {toast ? <Toast key={toast.key} text={toast.text} /> : null}
    </>
  );
}
