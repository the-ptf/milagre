import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { allComputers, useArchivedChats } from "../../all-computers";
import { createOpenGuard } from "../../archived-open";
import type { ArchivedChat } from "../../chat-list-archived";
import { Icon } from "../../icons";
import { ProjectIcon } from "../../project-icon";
import { useSession } from "../../session";
import { fonts, useTheme } from "../../theme";
import { ErrorNotice, PullDown, useStyles, type MenuSection } from "../../ui";

const keyOf = (item: ArchivedChat) => `${item.hostId}|${item.projectPath}#${item.chat.id}`;
const MENU: MenuSection[] = [{ items: [{ id: "unarchive", title: "Unarchive", systemImage: "tray.and.arrow.up" }] }];
const RADIUS = 20;

/** Settings › Archived Chats: the archived Chats of every computer, newest first. Tap opens one; Unarchive puts it back in the list. */
export default function ArchivedChatsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSession();
  const { chats, loading } = useArchivedChats();
  const [error, setError] = useState("");
  // The Chats being put back, by computer: a row takes no taps meanwhile.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // The Chat being opened: every row takes no taps meanwhile, whichever computer it is on.
  const [opening, setOpening] = useState<string | null>(null);
  const alive = useRef(true);
  // One open at a time for the whole page; leaving the page makes a pending one stale (see createOpenGuard).
  const [guard] = useState(() => createOpenGuard(session.cancelNavigation));
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useFocusEffect(
    useCallback(
      () => () => {
        guard.leave();
        setOpening(null);
      },
      [guard],
    ),
  );
  const working = async (item: ArchivedChat, work: () => Promise<void>) => {
    const key = keyOf(item);
    if (busy.has(key)) return;
    setBusy((current) => new Set(current).add(key));
    setError("");
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current)
        setBusy((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
    }
  };
  // Another computer is connected first, as the sidebar does; the sheet closes once the Chat is ready to show.
  const open = async (item: ArchivedChat) => {
    const ticket = guard.begin();
    if (!ticket) return;
    setOpening(keyOf(item));
    setError("");
    try {
      const { hostId, projectPath, chat } = item;
      if (hostId !== session.client?.url || !session.client) {
        const host = allComputers.hostFor(hostId);
        if (!host) throw new Error("This computer is no longer in your list.");
        const switched = await session.openNotificationTarget(host, projectPath, chat.id);
        if (!switched || !ticket.current() || !alive.current) return;
      }
      if (!ticket.current()) return;
      ticket.end();
      router.dismissAll();
      router.replace({ pathname: "/chat", params: { id: String(chat.id), projectPath, hostId } });
    } catch (e) {
      if (ticket.current() && alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      ticket.end();
      if (ticket.current() && alive.current) setOpening(null);
    }
  };
  // The same call the sidebar's Restore makes, through the Chat's own computer.
  const unarchive = (item: ArchivedChat) =>
    working(item, async () => {
      const { hostId, projectPath, chat } = item;
      const client = hostId === session.client?.url ? session.client : allComputers.clientFor(hostId);
      if (!client) throw new Error("This computer is no longer in your list.");
      const path = allComputers.viewOf(hostId)?.copies.get(projectPath)?.project.path ?? projectPath;
      await client.call("chat:patch", [path, chat.id, { archived: false }]);
      await Promise.all([
        allComputers.refreshProject(hostId, projectPath),
        hostId === session.client?.url && path === session.snapshot?.project.path ? session.refresh() : undefined,
      ]);
    });
  const many = new Set(chats.map((item) => item.hostId)).size > 1 || allComputers.views().length > 1;
  const renderItem = ({ item, index }: { item: ArchivedChat; index: number }) => {
    const key = keyOf(item);
    const taken = busy.has(key);
    const loadingThis = opening === key;
    const locked = opening !== null || taken;
    const label = `${item.title}, ${item.projectName}${item.branch ? `, ${item.branch}` : ""}${many ? `, ${item.hostName}` : ""}`;
    const first = index === 0;
    const last = index === chats.length - 1;
    return (
      // One card across the rows: each carries its slice of the card's background, border and corners.
      <View
        pointerEvents={locked ? "none" : "auto"}
        style={{
          opacity: taken || loadingThis ? 0.5 : 1,
          backgroundColor: colors.surface,
          borderColor: colors.line,
          borderLeftWidth: StyleSheet.hairlineWidth,
          borderRightWidth: StyleSheet.hairlineWidth,
          borderTopWidth: first ? StyleSheet.hairlineWidth : 0,
          borderBottomWidth: last ? StyleSheet.hairlineWidth : 0,
          borderTopLeftRadius: first ? RADIUS : 0,
          borderTopRightRadius: first ? RADIUS : 0,
          borderBottomLeftRadius: last ? RADIUS : 0,
          borderBottomRightRadius: last ? RADIUS : 0,
          borderCurve: "continuous",
          overflow: "hidden",
        }}
      >
        {index > 0 && <View style={[styles.separator, { marginLeft: 16 }]} />}
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <PullDown
            label={label}
            title={item.title}
            sections={locked ? [] : MENU}
            onSelect={(action) => {
              if (action === "unarchive") void unarchive(item);
            }}
            onPress={() => void open(item)}
            style={{ flex: 1 }}
          >
            <View style={{ gap: 3, paddingLeft: 16, paddingVertical: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 18 }}>
                <ProjectIcon client={allComputers.clientFor(item.hostId)} path={item.projectPath} size={16} />
                <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontSize: 13, fontWeight: "500" }}>
                  {item.projectName}
                </Text>
              </View>
              <Text numberOfLines={2} style={{ color: colors.ink, fontSize: 16, lineHeight: 21, fontWeight: "500" }}>
                {item.title}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 18 }}>
                {!!item.branch && (
                  <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink2, fontSize: 12, fontFamily: fonts.mono }}>
                    {item.branch}
                  </Text>
                )}
                {many && !!item.branch && <Text style={{ color: colors.ink2, fontSize: 12 }}>·</Text>}
                {many && (
                  <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink2, fontSize: 12 }}>
                    {item.hostName}
                  </Text>
                )}
              </View>
            </View>
          </PullDown>
          <PullDown
            label={`Actions for ${item.title}`}
            title={item.title}
            sections={locked ? [] : MENU}
            onSelect={(action) => action === "unarchive" && void unarchive(item)}
          >
            <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              {taken || loadingThis ? <ActivityIndicator size="small" color={colors.ink3} /> : <Icon icon={MoreHorizontalIcon} tone="ink3" size={18} />}
            </View>
          </PullDown>
        </View>
      </View>
    );
  };
  return (
    <>
      <Stack.Screen options={{ title: "Archived Chats" }} />
      <FlatList
        data={chats}
        keyExtractor={keyOf}
        renderItem={renderItem}
        // Rows rerender for the busy and opening state, which the list cannot see in `data`.
        extraData={`${opening ?? ""}|${[...busy].join(",")}|${many}`}
        style={styles.screen}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { gap: 0 }]}
        initialNumToRender={12}
        windowSize={7}
        ListHeaderComponent={
          error ? (
            <View style={{ marginBottom: 20 }}>
              <ErrorNotice message={error} />
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          loading ? (
            <View style={{ alignItems: "center", padding: 24 }}>
              <ActivityIndicator color={colors.ink3} />
            </View>
          ) : (
            <View style={[styles.card, { gap: 6 }]}>
              <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "600" }}>No archived Chats</Text>
              <Text style={styles.muted}>Chats you archive from the list show up here, and can be put back.</Text>
            </View>
          )
        }
      />
    </>
  );
}
