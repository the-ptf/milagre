import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Linking, Pressable, Text, TextInput, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import { File, Paths } from "expo-file-system";
import { ArrowLeft01Icon, BrowserIcon, Cancel01Icon, CommentAdd01Icon, Link01Icon, LinkSquare02Icon, Unlink04Icon } from "@hugeicons/core-free-icons";
import { openablePageUrl } from "@milagre/shared/loopback-url";
import type { BrowserFrame, BrowserList, BrowserTarget } from "@milagre/shared/browser";
import { createBrowserBridge, createBrowserReceiverHtml } from "@milagre/shared/browser-receiver";
import type { Client } from "./client";
import { useSession } from "./session";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { CircleButton, PageScroll, PillButton, useStyles } from "./ui";
import { radius, type } from "./design-tokens";
import type { ChatTab } from "./panel-tabs";
import { useReachableHost } from "./routes-native";

/** Poll this Chat's browser pages only while the screen is visible. Listing never starts a capture. */
function useBrowsers(client: Client | null, chatId: string | undefined, visible = true) {
  const [list, setList] = useState<BrowserList | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const listed = useRef("");
  useFocusEffect(
    useCallback(() => {
      if (!client || !chatId || !visible) return;
      let disposed = false,
        busy = false;
      // Keep the last list while returning to the same Chat, so the pill does not blink.
      const key = `${client.url}|${chatId}`;
      if (listed.current !== key) {
        listed.current = key;
        setList(null);
      }
      const load = async () => {
        if (AppState.currentState !== "active" || disposed || busy) return;
        busy = true;
        try {
          const value = await client.call<BrowserList>("browser:list", [{ chatId }]);
          if (!disposed) setList(value);
        } catch (error) {
          if (!disposed) setList({ supported: true, targets: [], others: [], error: error instanceof Error ? error.message : "Could not list browsers." });
        } finally {
          busy = false;
        }
      };
      refresh.current = load;
      void load();
      const timer = setInterval(load, 15000);
      const subscription = AppState.addEventListener("change", () => {
        void load();
      });
      return () => {
        disposed = true;
        clearInterval(timer);
        subscription.remove();
      };
    }, [client, chatId, visible]),
  );
  return { list, setList, refresh: () => refresh.current() };
}

/** The header offers Browser only while this Chat owns a page. */
export function useBrowserShortcut({ chatId, openInPanel }: { chatId?: string; openInPanel?: ((tab: ChatTab) => void) | null }) {
  const { client } = useSession();
  const { list } = useBrowsers(client, chatId);
  if (!client || !chatId || !list?.supported || !list.targets.length) return null;
  const count = list.targets.length;
  return {
    accessibilityLabel: `Browser, ${count} ${count === 1 ? "page" : "pages"} in this Chat`,
    onPress: () =>
      openInPanel
        ? openInPanel({ kind: "browser", target: { hostId: client.url, chatId } })
        : router.push({ pathname: "/browser-sheet", params: { hostId: client.url, chatId } }),
  };
}

const goBack = () => router.back();

export function BrowserSheet({
  hostId,
  chatId,
  url,
  requestId,
  onClose = goBack,
  visible = true,
}: {
  hostId?: string;
  chatId?: string;
  url?: string;
  requestId?: number;
  onClose?: () => void;
  visible?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { client } = useSession();
  const insets = useSafeAreaInsets();
  const source = client && (!hostId || hostId === client.url) ? client : null;
  const { list, setList, refresh } = useBrowsers(source, chatId, visible);
  const [chosen, setChosen] = useState<BrowserTarget | null>(null);
  const [page, setPage] = useState<{ title: string; url: string } | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  const [opened, setOpened] = useState<{ source: Client; chatId: string; url: string; attempt: number; requestId?: number; error: string } | null>(null);
  const openFinished =
    opened?.source === source && opened?.chatId === chatId && opened?.url === url && opened?.attempt === openAttempt && opened?.requestId === requestId;
  const opening = !!url && !openFinished;
  const openError = openFinished ? opened.error : "";
  useEffect(() => {
    if (!source || !chatId || !url) return;
    let disposed = false;
    void source.call<BrowserTarget>("browser:open-page", [{ chatId, url }]).then(
      (target) => {
        if (disposed) return;
        setChosen(target);
        setPage(null);
        setOpened({ source, chatId, url, attempt: openAttempt, requestId, error: "" });
      },
      (error) => {
        if (disposed) return;
        setOpened({
          source,
          chatId,
          url,
          attempt: openAttempt,
          requestId,
          error: error instanceof Error ? error.message : "Could not open the page. Open Milagre on your computer and retry.",
        });
      },
    );
    return () => {
      disposed = true;
    };
  }, [source, chatId, url, openAttempt, requestId]);
  const [choosing, setChoosing] = useState(false);
  const [attaching, setAttaching] = useState<string | null>(null);
  const selected = chosen ?? (!choosing && list?.targets.length === 1 ? list.targets[0] : null);
  const canChoose = (list?.targets.length ?? 0) > 1 || (list?.others.length ?? 0) > 0;
  const [paused, setPaused] = useState(AppState.currentState !== "active");
  const [revision, setRevision] = useState(0);
  // Comment mode on a Browser panel page: the next tap picks the element under it instead of clicking it.
  const [commenting, setCommenting] = useState(false);
  const [picked, setPicked] = useState<{ x: number; y: number } | null>(null);
  useFocusEffect(
    useCallback(() => {
      const subscription = AppState.addEventListener("change", (state) => {
        if (state !== "active") setPaused(true);
      });
      return () => {
        subscription.remove();
        setPaused(true);
      };
    }, []),
  );
  const attach = async (browserId: string) => {
    if (!source || !chatId) return;
    setAttaching(browserId);
    try {
      setList(await source.call<BrowserList>("browser:attach", [{ chatId, browserId }]));
    } catch (error) {
      setList((current) => ({
        supported: true,
        targets: current?.targets ?? [],
        others: current?.others ?? [],
        error: error instanceof Error ? error.message : "Could not attach the browser.",
      }));
    } finally {
      setAttaching(null);
    }
  };
  const detach = async (browserId: string) => {
    if (!source || !chatId) return;
    setAttaching(browserId);
    try {
      setList(await source.call<BrowserList>("browser:detach", [{ chatId, browserId }]));
      if (chosen?.id.startsWith(`${browserId}:`)) {
        setChosen(null);
        setPage(null);
      }
    } catch (error) {
      setList((current) => ({
        supported: true,
        targets: current?.targets ?? [],
        others: current?.others ?? [],
        error: error instanceof Error ? error.message : "Could not detach the browser.",
      }));
    } finally {
      setAttaching(null);
    }
  };
  const shown = opening || openError ? { title: "Browser", url: url ?? "" } : selected ? (page ?? { title: selected.title, url: selected.url }) : null;
  // The page in the phone's browser: the computer's localhost is reached at its address on this network, as reply links are.
  const reachableHost = useReachableHost(source?.url);
  const openExternally = () => {
    if (!shown) return;
    const { href, reason } = openablePageUrl(shown.url, { remote: true, host: reachableHost });
    if (href) void Linking.openURL(href).catch(() => Alert.alert("Could not open this page", `Visit ${href} in your browser.`));
    else Alert.alert("This page can't open here", reason);
  };
  return (
    <View style={{ flex: 1, backgroundColor: onClose === goBack ? colors.page : colors.surface, paddingBottom: insets.bottom }}>
      {/* Keep the header as one native view: form-sheet scroll sizing cannot account for a flattened header. */}
      <View
        collapsable={false}
        style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 8 }}
      >
        {selected && canChoose ? (
          <CircleButton
            label="Back to pages"
            icon={ArrowLeft01Icon}
            onPress={() => {
              setCommenting(false);
              setPicked(null);
              setChoosing(true);
              setChosen(null);
              setPage(null);
              void refresh();
            }}
          />
        ) : (
          <View style={{ width: 40 }} />
        )}
        {/* Balances the Open button beside Close, so the title stays centred. */}
        {selected && <View style={{ width: 40 }} />}
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
            {shown?.title || "Browser"}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 11 }}>
            {shown?.url || "This Chat"}
          </Text>
        </View>
        {selected && <CircleButton label="Open in your browser" icon={LinkSquare02Icon} onPress={openExternally} />}
        <CircleButton label="Close browser" icon={Cancel01Icon} onPress={onClose} />
      </View>
      <View collapsable={false} style={{ flex: 1, minHeight: 0 }}>
        {!visible ? null : !source || !chatId ? (
          <Text style={[styles.muted, { padding: 20 }]}>Reconnect to this computer to open its browsers.</Text>
        ) : opening ? (
          <Text style={[styles.muted, { padding: 20 }]}>Opening page in this Chat...</Text>
        ) : openError ? (
          <View style={{ padding: 20, gap: 16 }}>
            <Text accessibilityRole="alert" style={{ color: colors.redInk }}>
              {openError}
            </Text>
            <PillButton title="Retry" onPress={() => setOpenAttempt((value) => value + 1)} />
          </View>
        ) : paused ? (
          <View style={{ padding: 20, gap: 16 }}>
            <Text style={styles.muted}>Viewer paused while the app was hidden.</Text>
            <PillButton
              title="Retry"
              onPress={() => {
                setRevision((value) => value + 1);
                setPaused(false);
              }}
            />
          </View>
        ) : selected ? (
          <View style={{ flex: 1, minHeight: 0 }}>
            <BrowserWebView
              key={`${selected.id}:${revision}`}
              client={source}
              chatId={chatId}
              targetId={selected.id}
              onPage={(next) => {
                if (page && page.url !== next.url) {
                  setCommenting(false);
                  setPicked(null);
                }
                setPage(next);
              }}
              commenting={selected.source === "panel" && commenting}
              picked={picked}
              onClose={onClose}
              onPick={setPicked}
            />
            {selected.source === "panel" && (
              <PageComment
                key={selected.id}
                client={source}
                chatId={chatId}
                targetId={selected.id}
                commenting={commenting}
                picked={picked}
                onCommenting={(on) => {
                  setCommenting(on);
                  setPicked(null);
                }}
              />
            )}
          </View>
        ) : (
          <PageScroll
            style={{ flex: 1 }}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustContentInsets={false}
            contentContainerStyle={{ padding: 20, gap: 12 }}
          >
            {!list && <Text style={styles.muted}>Finding browser pages...</Text>}
            {!!list?.error && (
              <Text accessibilityRole="alert" style={{ color: colors.redInk }}>
                {list.error}
              </Text>
            )}
            {list?.supported === false && <Text style={styles.muted}>Browsers are unavailable on this computer.</Text>}
            {list?.supported && !list.error && !list.targets.length && (
              <Text style={styles.muted}>{"This Chat's agent has no open pages. Attach a browser below to view it here."}</Text>
            )}
            {list?.targets.map((target) => (
              <Pressable
                key={target.id}
                accessibilityRole="button"
                accessibilityLabel={`${target.title || target.url}, ${target.url}`}
                onPress={() => {
                  setChosen(target);
                  setPage(null);
                }}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  padding: 14,
                  gap: 10,
                  borderRadius: 12,
                  backgroundColor: pressed ? colors.hover : colors.surface,
                })}
              >
                <Icon icon={BrowserIcon} size={18} tone="ink2" />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 15 }}>
                    {target.title || target.url}
                  </Text>
                  <Text numberOfLines={1} style={styles.muted}>
                    {target.url}
                  </Text>
                </View>
                {target.source === "attached" ? (
                  <PillButton
                    title="Detach"
                    icon={Unlink04Icon}
                    secondary
                    loading={attaching === target.id.slice(0, target.id.indexOf(":"))}
                    disabled={attaching !== null}
                    onPress={() => void detach(target.id.slice(0, target.id.indexOf(":")))}
                  />
                ) : (
                  <Text style={styles.muted}>{target.browser}</Text>
                )}
              </Pressable>
            ))}
            {!!list?.others.length && (
              <Text accessibilityRole="header" style={[styles.muted, { paddingTop: 8 }]}>
                Other browsers on this computer
              </Text>
            )}
            {list?.others.map((other) => (
              <View
                key={other.id}
                style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 10, borderRadius: 12, backgroundColor: colors.surface }}
              >
                <Icon icon={BrowserIcon} size={18} tone="ink3" />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 15 }}>
                    {other.title || other.browser}
                  </Text>
                  <Text numberOfLines={1} style={styles.muted}>
                    {other.browser} · {other.pages} {other.pages === 1 ? "page" : "pages"}
                  </Text>
                </View>
                <PillButton
                  title="Attach"
                  icon={Link01Icon}
                  secondary
                  loading={attaching === other.id}
                  disabled={attaching !== null}
                  onPress={() => void attach(other.id)}
                />
              </View>
            ))}
          </PageScroll>
        )}
      </View>
    </View>
  );
}

/**
 * Comment mode for a Browser panel page: the button that starts it, the hint while it waits for a tap, and the box the
 * comment is written in. Sending makes the host read the element at the tapped point, screenshot it and send the
 * comment to the Chat's agent, as the desktop's Send does.
 */
function PageComment({
  client,
  chatId,
  targetId,
  commenting,
  picked,
  onCommenting,
}: {
  client: Client;
  chatId: string;
  targetId: string;
  commenting: boolean;
  picked: { x: number; y: number } | null;
  onCommenting(on: boolean): void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const send = async () => {
    if (!picked || !text.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      await client.call("browser-comments:send-from-page", [{ chatId, targetId, x: picked.x, y: picked.y, text: text.trim() }]);
      setText("");
      setSent(true);
      onCommenting(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The comment didn't send.");
    } finally {
      setSending(false);
    }
  };
  if (!commenting)
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}>
        <PillButton
          title="Comment"
          icon={CommentAdd01Icon}
          secondary
          onPress={() => {
            setSent(false);
            onCommenting(true);
          }}
        />
        {sent && <Text style={styles.muted}>Sent to the agent.</Text>}
      </View>
    );
  return (
    <View
      style={{
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: colors.surface,
        borderTopLeftRadius: radius.card,
        borderTopRightRadius: radius.card,
      }}
    >
      {!picked ? (
        <Text style={{ color: colors.ink2, fontSize: type.subheadline }}>Tap anywhere on the page to place a comment pin.</Text>
      ) : (
        <TextInput
          autoFocus
          multiline
          value={text}
          onChangeText={setText}
          placeholder="What should change here?"
          placeholderTextColor={colors.ink3}
          accessibilityLabel="Comment"
          style={{
            minHeight: 64,
            color: colors.ink,
            fontSize: type.body,
            padding: 10,
            borderRadius: radius.control,
            backgroundColor: colors.page,
          }}
        />
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.redInk, fontSize: type.footnote }}>
          {error}
        </Text>
      )}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10 }}>
        <PillButton title="Cancel" secondary disabled={sending} onPress={() => onCommenting(false)} />
        {picked && <PillButton title="Send" loading={sending} disabled={!text.trim() || sending} onPress={() => void send()} />}
      </View>
    </View>
  );
}

function BrowserWebView({
  client,
  chatId,
  targetId,
  onPage,
  onClose = goBack,
  commenting = false,
  onPick,
  picked = null,
}: {
  client: Client;
  chatId: string;
  targetId: string;
  onPage(page: { title: string; url: string }): void;
  onClose?: () => void;
  /** While set, a tap picks a point on the page (onPick, as fractions of it) instead of clicking it. */
  commenting?: boolean;
  onPick?(point: { x: number; y: number }): void;
  picked?: { x: number; y: number } | null;
}) {
  // Read by the bridge, which lives as long as the viewer: kept current without reconnecting it.
  const commentingRef = useRef(commenting);
  const onPickRef = useRef(onPick);
  const pickedRef = useRef(picked);
  useEffect(() => {
    commentingRef.current = commenting;
    onPickRef.current = onPick;
    pickedRef.current = picked;
  }, [commenting, onPick, picked]);
  const { colors, scheme } = useTheme();
  const styles = useStyles();
  const theme = useMemo(() => {
    // The sheet and its bottom safe area use page, not the raised surface color.
    return { ...colors, surface: colors.page, scheme };
  }, [colors, scheme]);
  const latestTheme = useRef(theme);
  const view = useRef<DomWebViewRef>(null);
  const syncTheme = useCallback(
    () => view.current?.injectJavaScript(`window.browserTheme?.(${JSON.stringify(latestTheme.current).replace(/</g, "\\u003c")});true;`),
    [],
  );
  useEffect(() => {
    latestTheme.current = theme;
    syncTheme();
  }, [theme, syncTheme]);
  const syncPin = useCallback(() => {
    view.current?.injectJavaScript(`window.browserCommentPoint?.(${JSON.stringify(pickedRef.current)});true;`);
  }, []);
  useEffect(syncPin, [picked, syncPin]);
  const [uri, setUri] = useState<string | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const bridge = useRef<ReturnType<typeof createBrowserBridge> | null>(null);
  useEffect(() => {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const frames: File[] = [];
    const drop = (file: File) => {
      try {
        if (file.exists) file.delete();
      } catch {
        /* The OS may purge cache files. */
      }
    };
    // Frames go to a local file and only its address crosses into the WebView, so image bytes never pass through injected script.
    const store = (method: string, result: unknown) => {
      if (method !== "frame" || !result) return result;
      const frame = result as BrowserFrame;
      const file = new File(Paths.cache, `browser-${token}-${frame.sequence}.jpg`);
      file.writeSync(frame.data, { encoding: "base64" });
      frames.push(file);
      while (frames.length > 2) drop(frames.shift()!);
      return { ...frame, data: "", uri: file.uri };
    };
    const currentBridge = createBrowserBridge(
      (method, args) => {
        // In comment mode a tap names a point instead of clicking: the receiver's mouse press and release stay here.
        // A swipe still scrolls the page (wheel input).
        const event = method === "input" ? (args as { event?: { kind?: string; phase?: string; x?: number; y?: number } }).event : undefined;
        // Keep the chosen point stable while its comment is being written.
        if (commentingRef.current && pickedRef.current && event?.kind === "wheel") return Promise.resolve({ accepted: true });
        if (commentingRef.current && event?.kind === "mouse") {
          if (event.phase === "up" && typeof event.x === "number" && typeof event.y === "number") onPickRef.current?.({ x: event.x, y: event.y });
          return Promise.resolve({ accepted: true });
        }
        return client.call(`browser:${method}`, [args]);
      },
      (reply) => {
        // Data stays JSON, never an executable string supplied by the remote peer.
        view.current?.injectJavaScript(`window.browserReply?.(${JSON.stringify(reply).replace(/</g, "\\u003c")});true;`);
      },
      store,
    );
    bridge.current = currentBridge;
    let cancelled = false;
    const file = new File(Paths.cache, `browser-${token}.html`);
    void Promise.resolve()
      .then(() => {
        if (cancelled) return;
        file.writeSync(createBrowserReceiverHtml({ chatId, targetId, theme: latestTheme.current }));
        setUri(file.uri);
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not prepare the browser viewer.");
      });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        view.current?.injectJavaScript("window.browserDispose?.();true;");
        currentBridge.dispose();
      }
    });
    return () => {
      cancelled = true;
      currentBridge.dispose();
      subscription.remove();
      drop(file);
      frames.forEach(drop);
    };
  }, [client, chatId, targetId, revision]);
  const failed = () => {
    bridge.current?.dispose();
    setError("The browser viewer stopped. Retry to reconnect.");
  };
  if (error)
    return (
      <View style={{ padding: 20, gap: 16 }}>
        <Text accessibilityRole="alert" style={{ color: colors.redInk }}>
          {error}
        </Text>
        <PillButton
          title="Retry"
          onPress={() => {
            setError("");
            setUri(null);
            setRevision((value) => value + 1);
          }}
        />
      </View>
    );
  if (!uri) return <Text style={[styles.muted, { padding: 20 }]}>Preparing viewer...</Text>;
  return (
    <DomWebView
      key={uri}
      ref={view}
      source={{ uri }}
      style={{ flex: 1 }}
      containerStyle={{ flex: 1 }}
      useExpoModulesBridge={false}
      scrollEnabled={false}
      bounces={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      onMessage={(event) => {
        try {
          const message = JSON.parse(event.nativeEvent.data);
          if (message.channel !== "milagre-browser") return;
          if (message.event === "close") {
            onClose();
            return;
          }
          if (message.event === "page") {
            onPage({ title: String(message.title ?? ""), url: String(message.url ?? "") });
            return;
          }
          if (message.method === "open") {
            syncTheme();
            syncPin();
          }
          void bridge.current?.receive(message);
        } catch {
          /* Only typed browser RPC messages enter the host. */
        }
      }}
      onContentProcessDidTerminate={failed}
      onRenderProcessGone={failed}
    />
  );
}
