import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import { File, Paths } from "expo-file-system";
import { ArrowDown01Icon, ArrowLeft01Icon, Cancel01Icon, SmartphoneIcon } from "@hugeicons/core-free-icons";
import type { SimulatorDevice, SimulatorFrame, SimulatorList } from "@milagre/shared/simulator";
import {
  createSimulatorBridge,
  createSimulatorReceiverHtml,
  SIMULATOR_CONNECTION_LABELS,
  type SimulatorConnection,
  type SimulatorConnectionState,
} from "@milagre/shared/simulator-receiver";
import type { Client } from "./client";
import { useSession } from "./session";
import { lineHeight, radius, type } from "./design-tokens";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { StatusPill } from "./status-pill";
import { CircleButton, ErrorNotice, PageScroll, PillButton, pressStyle, SheetHeader, useStyles } from "./ui";
import { usePanelTabs } from "./panel-tabs";

/** Poll discovery only while this screen is visible. Discovery never starts a video session. */
function useSimulators(client: Client | null, chatId?: string) {
  const [list, setList] = useState<SimulatorList | null>(null);
  const revision = useRef(0);
  const updateList: typeof setList = useCallback((value) => {
    revision.current++;
    setList(value);
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (!client || !chatId) return;
      let disposed = false,
        busy = false;
      setList(null);
      const refresh = async () => {
        if (AppState.currentState !== "active" || disposed || busy) return;
        busy = true;
        const started = revision.current;
        try {
          const value = await client.call<SimulatorList>("simulator:list", [{ chatId }]);
          if (value.chatId !== chatId) throw new Error("Update Milagre on this Mac to attach simulators to Chats.");
          if (!disposed && started === revision.current) setList(value);
        } catch (error) {
          if (!disposed && started === revision.current)
            setList({ devices: [], supported: true, error: error instanceof Error ? error.message : "Could not list simulators." });
        } finally {
          busy = false;
        }
      };
      void refresh();
      const timer = setInterval(refresh, 5000);
      const subscription = AppState.addEventListener("change", () => {
        void refresh();
      });
      return () => {
        disposed = true;
        clearInterval(timer);
        subscription.remove();
      };
    }, [client, chatId]),
  );
  return { list, setList: updateList };
}

export function SimulatorChip({ chatId }: { chatId: string }) {
  const { client } = useSession();
  const { list } = useSimulators(client, chatId);
  const openTab = usePanelTabs();
  const attachedCount = list?.attached?.length ?? 0;
  if (!client || !chatId || list?.supported === false || !attachedCount) return null;
  return (
    <StatusPill
      label="Simulators"
      count={attachedCount}
      icon={SmartphoneIcon}
      accessibilityLabel={`Simulators, ${attachedCount} attached to this Chat`}
      // On an iPad the viewer docks beside the Chat; on a phone it is a page of its own.
      onPress={() =>
        openTab
          ? openTab({ kind: "simulator", target: { hostId: client.url, chatId } })
          : router.push({ pathname: "/simulator-sheet", params: { hostId: client.url, chatId } })
      }
    />
  );
}

const goBack = () => router.back();

/** The viewer: a page of its own on a phone, a tab of the right panel on an iPad, which `onClose` closes. */
export function SimulatorSheet({ hostId, chatId, onClose = goBack }: { hostId?: string; chatId?: string; onClose?: () => void }) {
  const { colors } = useTheme();
  // In the iPad's right panel the viewer takes the panel's surface, so it runs on from the tab row with no seam.
  const docked = onClose !== goBack;
  const background = docked ? colors.surface : colors.page;
  const styles = useStyles();
  // The viewer header's sub-lines, as SheetHeader's subtitle: caption1 12/16 ink3.
  const caption = { color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 };
  const { client } = useSession();
  const insets = useSafeAreaInsets();
  const source = client && chatId && (!hostId || hostId === client.url) ? client : null;
  const { list, setList } = useSimulators(source, chatId);
  const [attaching, setAttaching] = useState(false),
    [busy, setBusy] = useState(false);
  const [chosen, setSelected] = useState<SimulatorDevice | null>(null);
  const [connection, setConnection] = useState<SimulatorConnection | null>(null);
  const [choosing, setChoosing] = useState(false);
  const selected = attaching
    ? null
    : ((chosen && list?.devices.find((d) => d.id === chosen.id)) ?? (!choosing && list?.devices.length === 1 ? list.devices[0] : null));
  const [paused, setPaused] = useState(AppState.currentState === "background");
  const connectionState = !source ? "error" : paused ? "paused" : connection?.deviceId === selected?.id && connection ? connection.state : "connecting";
  const [revision, setRevision] = useState(0);
  const pausedRef = useRef(paused);
  const pause = useCallback(() => {
    pausedRef.current = true;
    setPaused(true);
  }, []);
  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    setConnection(null);
    setRevision((value) => value + 1);
    setPaused(false);
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (AppState.currentState === "active") resume();
      // Notification Center, Control Center and screenshots only make the app inactive; video keeps playing.
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "background") pause();
        else if (state === "active") resume();
      });
      return () => {
        subscription.remove();
        pause();
      };
    }, [pause, resume]),
  );
  const mutate = async (method: "attach" | "detach", device: SimulatorDevice) => {
    if (!source || !chatId || busy) return;
    setBusy(true);
    setList((current) => current);
    try {
      const result = await source.call<SimulatorList>(`simulator:${method}`, [{ chatId, deviceId: device.id }]);
      setList(result);
      setAttaching(false);
      setChoosing(method === "detach");
      setSelected(method === "attach" ? device : null);
    } catch (error) {
      setList((current) => ({
        ...current,
        devices: current?.devices ?? [],
        supported: true,
        error: error instanceof Error ? error.message : "Could not update attachment.",
      }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: background,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
    >
      {/* One header view, kept by Fabric, sizes the native sheet. In the panel docked beside the Chat (an iPad), the panel's
      own button closes it. */}
      <View collapsable={false} style={{ flexShrink: 0 }}>
        {selected ? (
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 8 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${selected.name}, choose simulator`}
                onPress={() => {
                  setChoosing(true);
                  setSelected(null);
                }}
                hitSlop={12}
                style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 4 }, pressStyle({ pressed })]}
              >
                <Text
                  numberOfLines={1}
                  style={{ flexShrink: 1, color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}
                >
                  {selected.name}
                </Text>
                <Icon icon={ArrowDown01Icon} tone="ink3" size={16} />
              </Pressable>
              <Text style={caption}>
                {selected.platform === "android" ? "Android" : "iOS"} {selected.version}
              </Text>
            </View>
            <View accessibilityLabel={SIMULATOR_CONNECTION_LABELS[connectionState]} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: radius.full,
                  backgroundColor: connectionState === "live" ? colors.green : connectionState === "error" ? colors.red : colors.ink4,
                }}
              />
              <Text style={caption}>{SIMULATOR_CONNECTION_LABELS[connectionState]}</Text>
            </View>
            {onClose === goBack && <CircleButton label="Close simulator" icon={Cancel01Icon} onPress={onClose} />}
          </View>
        ) : (
          <SheetHeader
            title={attaching ? "Attach simulator" : "Simulators"}
            subtitle={attaching ? "Other devices on this Mac" : "This Chat"}
            leading={
              attaching ? (
                <CircleButton
                  label="Back to devices"
                  icon={ArrowLeft01Icon}
                  onPress={() => {
                    setChoosing(true);
                    setSelected(null);
                    setAttaching(false);
                  }}
                />
              ) : (
                <View style={{ width: 40, alignItems: "center" }}>
                  <Icon icon={SmartphoneIcon} tone="ink2" size={20} />
                </View>
              )
            }
            trailing={onClose === goBack ? <CircleButton label="Close simulator" icon={Cancel01Icon} onPress={onClose} /> : undefined}
          />
        )}
      </View>
      <View collapsable={false} style={{ flex: 1, minHeight: 0 }}>
        {!source ? (
          <Text style={[styles.muted, { padding: 16 }]}>Reconnect to this Mac to open its simulators.</Text>
        ) : paused ? (
          <View style={{ padding: 16, gap: 16 }}>
            <Text style={styles.muted}>Viewer paused while the app was hidden.</Text>
            <PillButton title="Retry" onPress={resume} />
          </View>
        ) : selected ? (
          <SimulatorWebView
            key={`${selected.id}:${revision}`}
            client={source}
            deviceId={selected.id}
            device={selected}
            chatId={chatId!}
            background={background}
            onConnection={setConnection}
          />
        ) : (
          <PageScroll
            style={{ flex: 1 }}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustContentInsets={false}
            contentContainerStyle={{ padding: 16, gap: 12 }}
          >
            {!list && <Text style={styles.muted}>Finding running simulators…</Text>}
            {!!list?.error && <ErrorNotice message={list.error} />}
            {list?.supported === false && <Text style={styles.muted}>Simulators are unavailable on this computer.</Text>}
            {list?.supported && !list.error && !(attaching ? list.available : list.attached)?.length && (
              <Text style={styles.muted}>{attaching ? "No other devices are running on this Mac." : "No simulators attached to this Chat."}</Text>
            )}
            {(attaching ? (list?.available ?? []) : (list?.attached ?? [])).map((device) => {
              const running = attaching || list?.devices.some((d) => d.id === device.id);
              return (
                <View
                  key={device.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${attaching ? "Attach " : ""}${device.name}`}
                    disabled={busy || !running}
                    onPress={() => (attaching ? void mutate("attach", device) : setSelected(device))}
                    style={({ pressed }) => [
                      {
                        flex: 1,
                        flexDirection: "row",
                        alignItems: "center",
                        minHeight: 48,
                        padding: 12,
                        gap: 12,
                        borderRadius: radius.control,
                        borderCurve: "continuous",
                        backgroundColor: docked ? colors.page : colors.surface,
                      },
                      pressStyle({ pressed, disabled: !running, kind: "row" }),
                    ]}
                  >
                    <Icon icon={SmartphoneIcon} size={18} tone="ink2" />
                    <Text style={{ flex: 1, color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{device.name}</Text>
                    <Text style={styles.muted}>{running ? `${device.platform === "android" ? "Android" : "iOS"} ${device.version}` : "Stopped"}</Text>
                  </Pressable>
                  {!attaching && (
                    <CircleButton label={`Detach ${device.name} from Chat`} icon={Cancel01Icon} disabled={busy} onPress={() => void mutate("detach", device)} />
                  )}
                </View>
              );
            })}
            {!attaching && <PillButton title="Attach simulator" onPress={() => setAttaching(true)} />}
          </PageScroll>
        )}
      </View>
    </View>
  );
}

function SimulatorWebView({
  client,
  deviceId,
  device,
  chatId,
  background,
  onConnection,
}: {
  client: Client;
  deviceId: string;
  device?: SimulatorDevice;
  chatId: string;
  /** The viewer page's background: the sheet's page color, or the iPad panel's surface. */
  background: string;
  onConnection?(connection: SimulatorConnection): void;
}) {
  const { colors, scheme } = useTheme();
  const styles = useStyles();
  const theme = useMemo(() => {
    // The page and its bottom safe area use the screen's own background, not the raised surface color.
    return { ...colors, surface: background, scheme };
  }, [colors, background, scheme]);
  const latestTheme = useRef(theme);
  const view = useRef<DomWebViewRef>(null);
  // The native viewer is keyed by device id; polling metadata never restarts its WebView.
  const [receiverConfig] = useState(() => ({ deviceId, device }));
  const syncTheme = useCallback(
    () => view.current?.injectJavaScript(`window.simulatorTheme?.(${JSON.stringify(latestTheme.current).replace(/</g, "\\u003c")});true;`),
    [],
  );
  useEffect(() => {
    latestTheme.current = theme;
    syncTheme();
  }, [theme, syncTheme]);
  const [uri, setUri] = useState<string | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const bridge = useRef<ReturnType<typeof createSimulatorBridge> | null>(null);
  useEffect(() => {
    onConnection?.({ deviceId: receiverConfig.deviceId, state: "connecting" });
    const frameFiles: File[] = [];
    let frameRevision = 0;
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const drop = (file: File) => {
      try {
        if (file.exists) file.delete();
      } catch {
        /* The OS may purge cached frames. */
      }
    };
    const currentBridge = createSimulatorBridge(
      (method, args) => client.call(`simulator:${method}`, [method === "open" ? { ...(args as object), chatId } : args]),
      (reply) => {
        // Data stays JSON, never an executable string supplied by the remote peer.
        view.current?.injectJavaScript(`window.simulatorReply?.(${JSON.stringify(reply).replace(/</g, "\\u003c")});true;`);
      },
      (method, result) => {
        if (method !== "frame" || !result) return result;
        const frame = result as SimulatorFrame;
        if (
          !Number.isSafeInteger(frame.sequence) ||
          frame.sequence < 1 ||
          !["image/jpeg", "image/png"].includes(frame.mimeType) ||
          typeof frame.data !== "string" ||
          frame.data.length > 2796204
        )
          throw new Error("Invalid simulator frame.");
        // Image bytes stay out of injected JavaScript. Retain only the current and previous file.
        const file = new File(Paths.cache, `simulator-${token}-${++frameRevision}.${frame.mimeType === "image/png" ? "png" : "jpg"}`);
        frameFiles.push(file);
        file.writeSync(frame.data, { encoding: "base64" });
        while (frameFiles.length > 2) drop(frameFiles.shift()!);
        return { ...frame, data: "", uri: file.uri };
      },
    );
    bridge.current = currentBridge;
    let cancelled = false;
    const file = new File(Paths.cache, `simulator-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    void Promise.resolve()
      .then(() => {
        if (cancelled) return;
        file.writeSync(
          createSimulatorReceiverHtml({
            ...receiverConfig,
            theme: latestTheme.current,
            touchControls: true,
          }),
        );
        setUri(file.uri);
      })
      .catch((failure) => {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "Could not prepare the simulator viewer.");
          onConnection?.({ deviceId: receiverConfig.deviceId, state: "error" });
        }
      });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        view.current?.injectJavaScript("window.simulatorDispose?.();true;");
        currentBridge.dispose();
      }
    });
    return () => {
      cancelled = true;
      currentBridge.dispose();
      subscription.remove();
      frameFiles.forEach(drop);
      try {
        if (file.exists) file.delete();
      } catch {
        /* The OS may purge cache files while backgrounding. */
      }
    };
  }, [client, receiverConfig, chatId, revision, onConnection]);
  const failed = () => {
    bridge.current?.dispose();
    onConnection?.({ deviceId, state: "error" });
    setError("The simulator viewer stopped. Retry to reconnect.");
  };
  if (error)
    return (
      <View style={{ padding: 16 }}>
        <ErrorNotice
          message={error}
          retryTitle="Retry"
          retry={() => {
            setError("");
            setUri(null);
            setRevision((value) => value + 1);
          }}
        />
      </View>
    );
  if (!uri) return <Text style={[styles.muted, { padding: 16 }]}>Preparing viewer…</Text>;
  return (
    <DomWebView
      key={uri}
      ref={view}
      source={{ uri }}
      style={{ flex: 1 }}
      containerStyle={{ flex: 1 }}
      useExpoModulesBridge={false}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      allowsPictureInPictureMediaPlayback={false}
      allowsAirPlayForMediaPlayback={false}
      scrollEnabled={false}
      bounces={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      onMessage={(event) => {
        try {
          const message = JSON.parse(event.nativeEvent.data);
          if (message.channel === "milagre-simulator" && message.event === "state" && Object.hasOwn(SIMULATOR_CONNECTION_LABELS, message.state)) {
            onConnection?.({
              deviceId,
              state: message.state as SimulatorConnectionState,
            });
            return;
          }
          if (message.channel === "milagre-simulator" && message.method === "open") syncTheme();
          void bridge.current?.receive(message);
        } catch {
          /* Only typed simulator RPC messages enter the host. */
        }
      }}
      onContentProcessDidTerminate={failed}
      onRenderProcessGone={failed}
    />
  );
}
