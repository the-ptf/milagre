import { nativeActivity } from "../live-activity-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, RefreshControl, Text, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { Add01Icon, ComputerIcon, LaptopIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession, type HostLink } from "../session";
import { usePush } from "../push";
import { savedHosts } from "../hosts-native";
import { confirmSheet } from "../confirm-store";
import { createClient } from "../client";
import { relayRuntime } from "../relay-native";
import { lanRoutes } from "../routes-native";
import type { SavedHost } from "../hosts-store";
import { Icon } from "../icons";
import { ErrorNotice, HeaderButton, IconButton, ListRow, PageScroll, showActions, useStyles } from "../ui";
import { useTheme } from "../theme";
import { UpdateSettingsBadge, useAppUpdates } from "../update-sheet";

type Reachability = "online" | "checking" | "offline";
const DEMO = process.env.EXPO_PUBLIC_DEMO === "1";

export default function ComputersScreen() {
  const updates = useAppUpdates();
  const updateAvailable = ["ready", "downloading", "error"].includes(updates.state.status);
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const push = usePush();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<Record<string, Reachability>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [, setRouteTick] = useState(0);
  const autoOpened = useRef(false);
  const check = useCallback(async (hosts: SavedHost[]) => {
    setStatus(Object.fromEntries(hosts.map((host) => [host.id, "checking"])));
    await Promise.all(
      hosts.map(async (host) => {
        let next: Reachability = "offline";
        try {
          await createClient(host, fetch, 5000, relayRuntime).call("daemon:status");
          next = "online";
        } catch {
          /* unreachable */
        }
        setStatus((current) => ({ ...current, [host.id]: next }));
      }),
    );
  }, []);
  const load = useCallback(async () => {
    try {
      const hosts = await session.loadHosts();
      setError("");
      void check(hosts);
      return hosts;
    } catch (e) {
      setError((e as Error).message);
      return [];
    }
  }, [session.loadHosts, check]); // eslint-disable-line react-hooks/exhaustive-deps
  async function open(host: HostLink, resume = false) {
    setBusy(host.address);
    setError("");
    try {
      if (await session.connect(host, !DEMO)) router.replace({ pathname: "/projects", params: { resume: resume ? "1" : "0" } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useEffect(() => {
    const unsubscribe = session.hosts.map((host) => lanRoutes.subscribe(host.id, () => setRouteTick((tick) => tick + 1)));
    return () => unsubscribe.forEach((stop) => stop());
  }, [session.hosts]);
  useEffect(() => {
    // Resume the last computer (or the only pairing) once, unless a deep link takes over.
    if (autoOpened.current || !session.booted) return;
    const target =
      DEMO && process.env.EXPO_PUBLIC_DAEMON_URL && process.env.EXPO_PUBLIC_DAEMON_TOKEN
        ? { address: process.env.EXPO_PUBLIC_DAEMON_URL, token: process.env.EXPO_PUBLIC_DAEMON_TOKEN, name: "Demo host" }
        : !session.client
          ? (session.hosts.find((host) => host.id === session.lastLocation?.hostId) ?? (session.hosts.length === 1 ? session.hosts[0] : null))
          : null;
    if (!target || !session.claimAutoOpen()) return;
    autoOpened.current = true;
    const version = session.navigationVersion();
    // A hosts refresh can render again immediately. It must not cancel an already claimed auto-open.
    void Promise.resolve().then(() => {
      if (session.navigationVersion() === version) void open(target, true);
    });
  }, [session.hosts, session.booted]); // eslint-disable-line react-hooks/exhaustive-deps
  function manage(host: SavedHost, action: string) {
    if (action === "rename")
      Alert.prompt(
        "Rename computer",
        undefined,
        (name) =>
          void savedHosts
            .rename(host.id, name)
            .then(load)
            .catch((e) => setError(e.message)),
        "plain-text",
        host.name,
      );
    if (action === "forget")
      confirmSheet(`Forget ${host.name}?`, "You will need to scan its code again to reconnect.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => {
            session.cancelNavigation();
            if (session.client?.url === host.address) session.disconnect();
            void push
              .forget(host)
              .then(() => nativeActivity?.endAsync(host.id))
              .then(() => savedHosts.forget(host.id))
              .then(() => {
                if (host.relay) relayRuntime.forget(host.relay.hostId);
                lanRoutes.forget(host.id);
              })
              .then(load)
              .catch((e) => setError(e.message));
          },
        },
      ]);
  }
  const dot = (state?: Reachability) => (state === "online" ? colors.green : state === "offline" ? colors.red : colors.orange);
  const label = (state?: Reachability) => (state === "online" ? "Online" : state === "offline" ? "Offline" : "Checking…");
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Computers" }} />
      <Stack.Toolbar placement="right">
        {Platform.OS === "ios" ? (
          <Stack.Toolbar.Button
            icon="gearshape"
            accessibilityLabel={updateAvailable ? "Settings, update available" : "Settings"}
            onPress={() => router.push("/settings")}
          >
            {updateAvailable && <Stack.Toolbar.Badge style={{ backgroundColor: colors.green }} />}
          </Stack.Toolbar.Button>
        ) : (
          <Stack.Toolbar.View>
            <View>
              <HeaderButton label="Settings" icon={Settings01Icon} onPress={() => router.push("/settings")} />
              <UpdateSettingsBadge />
            </View>
          </Stack.Toolbar.View>
        )}
      </Stack.Toolbar>
      {Platform.OS === "ios" && (
        <Stack.Toolbar placement="bottom">
          <Stack.Toolbar.Spacer />
          <Stack.Toolbar.Button icon="plus" accessibilityLabel="Add computer" onPress={() => router.push("/add-computer")} />
        </Stack.Toolbar>
      )}
      <PageScroll
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {session.hosts.length > 0 ? (
          <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
            {session.hosts.map((host, index) => (
              <View key={host.id}>
                {index > 0 && <View style={styles.separator} />}
                <ListRow
                  onLongPress={() =>
                    showActions({
                      title: host.name,
                      actions: [
                        { id: "rename", title: "Rename" },
                        { id: "forget", title: "Forget", destructive: true },
                      ],
                      onSelect: (action) => manage(host, action),
                    })
                  }
                  title={host.name}
                  subtitle={`${label(status[host.id])} · ${
                    status[host.id] === "online" && lanRoutes.kind(host.id) === "lan"
                      ? "Local network"
                      : host.relay
                        ? host.relay.url.replace(/^wss:\/\//, "")
                        : host.address.replace(/^https?:\/\//, "")
                  }`}
                  disabled={!!busy}
                  onPress={() => void open(host)}
                  leading={
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 10,
                        borderCurve: "continuous",
                        backgroundColor: colors.field,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon icon={/studio|mini|imac/i.test(host.name) ? ComputerIcon : LaptopIcon} tone="ink" size={20} />
                      <View
                        style={{
                          position: "absolute",
                          right: -2,
                          bottom: -2,
                          width: 11,
                          height: 11,
                          borderRadius: 6,
                          backgroundColor: dot(status[host.id]),
                          borderWidth: 2,
                          borderColor: colors.surface,
                        }}
                      />
                    </View>
                  }
                />
              </View>
            ))}
          </View>
        ) : (
          <View style={{ gap: 16, paddingTop: 48, alignItems: "center" }}>
            <Icon icon={LaptopIcon} tone="ink3" size={44} />
            <Text style={[styles.subtitle, { textAlign: "center" }]}>Pair your computer</Text>
            <Text style={[styles.muted, { textAlign: "center" }]}>
              Open Settings → Devices in Milagre on your Mac, then scan its pairing code. Your projects and chats will appear here.
            </Text>
          </View>
        )}
        {error ? <ErrorNotice message={error} /> : null}
      </PageScroll>
      {Platform.OS !== "ios" && (
        <View style={{ alignItems: "flex-end", paddingHorizontal: 20, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16) }}>
          <IconButton label="Add computer" icon={Add01Icon} filled size={48} onPress={() => router.push("/add-computer")} />
        </View>
      )}
    </View>
  );
}
