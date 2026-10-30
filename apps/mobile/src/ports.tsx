import { useCallback, useRef, useState } from "react";
import { Linking, AppState, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { Cancel01Icon, Copy01Icon, EthernetPortIcon, StopCircleIcon } from "@hugeicons/core-free-icons";
import type { AgentPort } from "@milagre/shared/model";
import type { Client } from "./client";
import { listensBeyondLoopback, reachableUrl } from "@milagre/shared/loopback-url";
import { useSession } from "./session";
import { useReachableHost } from "./routes-native";
import { Icon } from "./icons";
import { CircleButton, ErrorNotice, PageScroll, PillButton, useStyles } from "./ui";
import { useTheme } from "./theme";
import { StatusPill } from "./status-pill";
import { useInternalBrowser } from "./browser-setting";
import { openBrowserLink } from "./browser-link";
import { useChatPanelTabs } from "./side-panels";

/** The host returns only this Chat's proven processes. A Worktree is never an owner. */
export function useChatPorts(client: Client | null, chatId?: string) {
  const [ports, setPorts] = useState<AgentPort[]>([]);
  const [error, setError] = useState("");
  const reload = useRef<(() => Promise<void>) | null>(null);
  useFocusEffect(
    useCallback(() => {
      setPorts([]);
      setError("");
      if (!client || !chatId) return;
      let disposed = false,
        busy = false,
        sequence = 0;
      const refresh = async (force = false) => {
        if (disposed || AppState.currentState !== "active" || (busy && !force)) return;
        busy = true;
        const request = ++sequence;
        try {
          const result = await client.call<{ chatId: string; ports: AgentPort[] }>("chat:ports", [chatId]);
          if (result.chatId !== chatId) throw new Error("Update Milagre on your computer to view this Chat's ports.");
          if (!disposed && sequence === request) {
            setPorts(result.ports);
            setError("");
          }
        } catch (failure) {
          if (!disposed && sequence === request) {
            setPorts([]);
            setError(failure instanceof Error ? failure.message : "Could not list ports.");
          }
        } finally {
          if (sequence === request) busy = false;
        }
      };
      reload.current = () => refresh(true);
      void refresh();
      const timer = setInterval(() => void refresh(), 5000);
      const subscription = AppState.addEventListener("change", () => void refresh());
      return () => {
        disposed = true;
        reload.current = null;
        clearInterval(timer);
        subscription.remove();
      };
    }, [client, chatId]),
  );
  // A server Stop ended leaves the list at once; the refresh after it has the host's word.
  const drop = useCallback((pids: number[]) => setPorts((current) => current.filter((port) => !pids.includes(port.pid))), []);
  return { ports, error, refresh: () => reload.current?.(), drop };
}

/** `ports` come from the Chat screen's useChatPorts, which its background line reads too. */
export function PortsChip({ chatId, ports }: { chatId: string; ports: AgentPort[] }) {
  const { client } = useSession();
  if (!client || !chatId || !ports.length) return null;
  return (
    <StatusPill
      label="Ports"
      count={ports.length}
      icon={EthernetPortIcon}
      accessibilityLabel={`Ports, ${ports.length} listening`}
      onPress={() => router.push({ pathname: "/ports-sheet", params: { hostId: client.url, chatId } })}
    />
  );
}

export function PortsSheet({ hostId, chatId }: { hostId?: string; chatId?: string }) {
  const openTab = useChatPanelTabs(hostId, chatId);
  const [internalBrowser] = useInternalBrowser();
  const { colors } = useTheme();
  const styles = useStyles();
  const { client } = useSession();
  const source = client && chatId && hostId === client.url ? client : null;
  const { ports, error, refresh, drop } = useChatPorts(source, chatId);
  const insets = useSafeAreaInsets();
  const [stopping, setStopping] = useState<number[]>([]);
  const [actionError, setActionError] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  // The computer's IP on the phone's LAN route: a server that listens beyond loopback opens there from the phone.
  const reachableHost = useReachableHost(source?.url);
  const linkOf = (port: AgentPort) =>
    reachableHost && listensBeyondLoopback(port.address) ? reachableUrl(`http://localhost:${port.port}`, reachableHost) : null;
  const pending = useRef(new Set<number>());
  const stop = async (pids: number[]) => {
    if (!source || !chatId) return;
    const targets = [...new Set(pids)].filter((pid) => !pending.current.has(pid));
    if (!targets.length) return;
    targets.forEach((pid) => pending.current.add(pid));
    setStopping([...pending.current]);
    setActionError("");
    try {
      const results = await Promise.allSettled(targets.map((pid) => source.call<boolean>("agent:stop-port", [chatId, pid])));
      drop(
        targets.filter((_, index) => {
          const result = results[index];
          return result?.status === "fulfilled" && result.value === true;
        }),
      );
      await refresh();
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "Could not stop the server.");
    } finally {
      targets.forEach((pid) => pending.current.delete(pid));
      setStopping([...pending.current]);
    }
  };
  const copy = async (port: AgentPort) => {
    try {
      await Clipboard.setStringAsync(linkOf(port) ?? `http://${port.address === "::1" ? "[::1]" : "localhost"}:${port.port}`);
      setCopied(port.port);
    } catch {
      setActionError("Could not copy the address.");
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.page, paddingBottom: insets.bottom }}>
      <View style={{ flexDirection: "row", alignItems: "center", padding: 16, gap: 12 }}>
        <Icon icon={EthernetPortIcon} tone="ink2" size={22} />
        <View style={{ flex: 1 }}>
          <Text style={styles.subtitle}>Ports</Text>
          <Text style={styles.muted}>This Chat</Text>
        </View>
        <CircleButton label="Close ports" icon={Cancel01Icon} onPress={() => router.back()} />
      </View>
      <View collapsable={false} style={{ flex: 1, minHeight: 0 }}>
        <PageScroll
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
        >
          {!source ? (
            <Text style={styles.muted}>Open ports from the connected Chat.</Text>
          ) : (
            <>
              {!!(error || actionError) && <ErrorNotice message={actionError || error} retry={() => void refresh()} />}
              {!error && !ports.length && <Text style={styles.muted}>No ports running in this Chat.</Text>}
              {ports.length > 1 && (
                <PillButton title="Stop all" secondary disabled={stopping.length > 0} onPress={() => void stop(ports.map((port) => port.pid))} />
              )}
              {ports.map((port) => (
                <View key={port.port} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Pressable
                    style={{ flex: 1 }}
                    accessibilityRole="link"
                    accessibilityLabel={`Open http://localhost:${port.port}`}
                    onPress={() => {
                      if (!internalBrowser) {
                        const url = linkOf(port);
                        if (!url) setActionError("This server is only reachable in Milagre's Browser. Enable Open links in Milagre in Settings > Browser.");
                        else void Linking.openURL(url).catch(() => setActionError("Could not open the address."));
                      } else if (source && chatId) {
                        if (openTab) router.back();
                        openBrowserLink(source.url, chatId, `http://localhost:${port.port}`, openTab);
                      }
                    }}
                  >
                    <Text style={{ fontSize: 17, color: colors.accent, fontVariant: ["tabular-nums"] }}>:{port.port}</Text>
                    <Text style={styles.muted}>
                      {port.command}
                      {/* Bound to the computer's loopback: only the computer itself opens it. */}
                      {reachableHost && !listensBeyondLoopback(port.address) ? " · localhost only" : ""}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={copied === port.port ? `Copied address for port ${port.port}` : `Copy address for port ${port.port}`}
                    onPress={() => void copy(port)}
                    style={{ padding: 12 }}
                  >
                    <Icon icon={Copy01Icon} tone="ink2" size={20} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Stop port ${port.port}`}
                    disabled={stopping.includes(port.pid)}
                    onPress={() => stop([port.pid])}
                    style={{ padding: 12, opacity: stopping.includes(port.pid) ? 0.4 : 1 }}
                  >
                    <Icon icon={StopCircleIcon} tone="ink2" size={20} />
                  </Pressable>
                </View>
              ))}
              {copied !== null && (
                <Text accessibilityLiveRegion="polite" style={styles.muted}>
                  Computer address copied.
                </Text>
              )}
            </>
          )}
        </PageScroll>
      </View>
    </View>
  );
}
