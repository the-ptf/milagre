import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BrowserIcon,
  Cancel01Icon,
  CommentAdd01Icon,
  Link01Icon,
  LinkSquare02Icon,
  Refresh01Icon,
  Unlink04Icon,
} from "@hugeicons/core-free-icons";
import type { BrowserList, BrowserTarget } from "@milagre/shared/browser";
import { PAGE_PICK_CANCEL, pagePickScript } from "@milagre/shared/page-picker";
import type { PageElement } from "@milagre/shared/page-comments";
import { directPageUrl, externalPageUrl, originalPageUrl, pairedPageHost, privatePage } from "./browser-page-url";
import type { Client } from "./client";
import { useSession } from "./session";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { announce, CircleButton, EmptyState, ErrorNotice, Field, InlineError, PageScroll, PillButton, SectionLabel, SheetHeader, useStyles } from "./ui";
import { over } from "@milagre/shared/themes";
import { lineHeight, radius, type } from "./design-tokens";
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
  // Each link is a local page, even when the host has no desktop window open.
  const requested = url ? { id: `link:${requestId ?? url}`, title: "", url, browser: "Browser", source: "panel" as const } : null;
  const linkKey = `${hostId}:${chatId}:${url}:${requestId}`;
  const [lastLink, setLastLink] = useState(linkKey);
  const [chosen, setChosen] = useState<BrowserTarget | null>(requested);
  const [page, setPage] = useState<{ title: string; url: string } | null>(null);
  if (lastLink !== linkKey) {
    setLastLink(linkKey);
    setChosen(requested);
    setPage(null);
  }
  const [choosing, setChoosing] = useState(false);
  const [attaching, setAttaching] = useState<string | null>(null);
  const automatic = !choosing && list?.targets.length === 1 ? list.targets[0] : null;
  if (lastLink === linkKey && !chosen && automatic) setChosen({ ...automatic });
  const selected = chosen ?? automatic;
  const canChoose = (list?.targets.length ?? 0) > 1 || (list?.others.length ?? 0) > 0;
  const [commenting, setCommenting] = useState(false);
  const [picked, setPicked] = useState<PageElement | null>(null);
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
  const shown = selected ? (page ?? { title: selected.title, url: selected.url }) : null;
  const reachableHost = useReachableHost(source?.url) ?? pairedPageHost(source?.url);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const openExternally = () => {
    if (externalUrl) void Linking.openURL(externalUrl).catch(() => Alert.alert("Could not open this page", "Try opening the page again."));
  };
  return (
    <View style={{ flex: 1, backgroundColor: onClose === goBack ? colors.page : colors.surface, paddingBottom: insets.bottom }}>
      {/* Keep the header as one native view: form-sheet scroll sizing cannot account for a flattened header. */}
      <View collapsable={false} style={{ flexShrink: 0 }}>
        <SheetHeader
          title={shown?.title || "Browser"}
          subtitle={shown?.url || "This Chat"}
          subtitleEllipsis={shown?.url ? "middle" : "tail"}
          leading={
            selected && canChoose ? (
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
            ) : null
          }
          trailing={
            <>
              {selected && <CircleButton label="Open in browser" icon={LinkSquare02Icon} onPress={openExternally} />}
              <CircleButton label="Close browser" icon={Cancel01Icon} onPress={onClose} />
            </>
          }
        />
      </View>
      <View collapsable={false} style={{ flex: 1, minHeight: 0 }}>
        {!visible ? null : !source || !chatId ? (
          <Text style={[styles.muted, { padding: 16 }]}>Reconnect to this computer to open its browsers.</Text>
        ) : selected ? (
          <View style={{ flex: 1, minHeight: 0 }}>
            <BrowserWebView
              key={`page:${selected.id}`}
              client={source}
              chatId={chatId}
              url={selected.url}
              host={reachableHost}
              onExternalUrl={setExternalUrl}
              onPage={(next) => {
                if (page && page.url !== next.url) {
                  setCommenting(false);
                  setPicked(null);
                }
                setPage(next);
              }}
              commenting={selected.source === "panel" && commenting}
              picked={picked}
              onPick={setPicked}
            />
            {selected.source === "panel" && (
              <PageComment
                key={selected.id}
                client={source}
                chatId={chatId}
                page={shown ?? selected}
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
            contentContainerStyle={{ padding: 16, gap: 12 }}
          >
            {!list && <Text style={styles.muted}>Finding browser pages…</Text>}
            {!!list?.error && <ErrorNotice message={list.error} />}
            {list?.supported === false && <Text style={styles.muted}>Browsers are unavailable on this computer.</Text>}
            {list?.supported && !list.error && !list.targets.length && (
              <EmptyState icon={BrowserIcon} title="This Chat's agent has no open pages">
                Attach a browser below to view it here.
              </EmptyState>
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
                  padding: 12,
                  gap: 12,
                  borderRadius: radius.control,
                  borderCurve: "continuous",
                  backgroundColor: pressed ? over(colors.hover, colors.surface) : colors.surface,
                })}
              >
                <Icon icon={BrowserIcon} size={18} tone="ink2" />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
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
              <SectionLabel flush style={{ paddingTop: 8 }}>
                Other browsers on this computer
              </SectionLabel>
            )}
            {list?.others.map((other) => (
              <View
                key={other.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  padding: 12,
                  gap: 12,
                  borderRadius: radius.control,
                  borderCurve: "continuous",
                  backgroundColor: colors.surface,
                }}
              >
                <Icon icon={BrowserIcon} size={18} tone="ink3" />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
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
  page,
  commenting,
  picked,
  onCommenting,
}: {
  client: Client;
  chatId: string;
  page: { url: string; title: string };
  commenting: boolean;
  picked: PageElement | null;
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
      await client.call("browser-comments:send-from-page", [{ chatId, page: { ...page, element: picked }, text: text.trim() }]);
      setText("");
      setSent(true);
      announce("Sent to the agent.");
      onCommenting(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The comment didn't send.");
    } finally {
      setSending(false);
    }
  };
  if (!commenting)
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}>
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
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: colors.surface,
        borderTopLeftRadius: radius.card,
        borderTopRightRadius: radius.card,
      }}
    >
      {!picked ? (
        <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
          Tap anywhere on the page to place a comment pin.
        </Text>
      ) : (
        <Field
          label="Comment"
          hideLabel
          autoFocus
          multiline
          autoCapitalize="sentences"
          autoCorrect
          value={text}
          onChangeText={setText}
          placeholder="What should change here?"
          style={{ minHeight: 64, backgroundColor: colors.page }}
        />
      )}
      <InlineError message={error} />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12 }}>
        <PillButton title="Cancel" variant="plain" muted disabled={sending} onPress={() => onCommenting(false)} />
        {picked && <PillButton title="Send" loading={sending} disabled={!text.trim() || sending} onPress={() => void send()} />}
      </View>
    </View>
  );
}

function BrowserWebView({
  client,
  url,
  host,
  onPage,
  onExternalUrl,
  commenting = false,
  onPick,
  picked = null,
}: {
  client: Client;
  chatId: string;
  url: string;
  host: string | null;
  onPage(page: { title: string; url: string }): void;
  onExternalUrl(url: string | null): void;
  commenting?: boolean;
  onPick(element: PageElement | null): void;
  picked?: PageElement | null;
}) {
  const styles = useStyles();
  const view = useRef<DomWebViewRef>(null);
  const [route, setRoute] = useState<{ uri: string; origin: string; external: string } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [forceProxy, setForceProxy] = useState(false);
  const ready = useRef(false);
  const latest = useRef({ onPage, onPick, onExternalUrl });
  useEffect(() => {
    latest.current = { onPage, onPick, onExternalUrl };
  });
  useEffect(() => {
    let disposed = false;
    let lease: string | undefined;
    const renew = async () => {
      if (!lease || AppState.currentState !== "active" || disposed) return;
      try {
        const alive = await client.call<boolean>("browser:keep-page-url", [{ id: lease }]);
        if (!alive && !disposed) setAttempt((value) => value + 1);
      } catch {
        /* Reconnect or the next heartbeat retries. */
      }
    };
    const heartbeat = setInterval(() => void renew(), 60_000);
    const subscription = AppState.addEventListener("change", () => void renew());
    ready.current = false;
    latest.current.onExternalUrl(null);
    const direct = !forceProxy && directPageUrl(url, host);
    const open = async () => {
      if (!/^https?:\/\//i.test(url)) throw new Error("Only HTTP and HTTPS pages open in Browser.");
      if (direct) return { uri: direct, origin: new URL(direct).origin, external: direct };
      const result = await client.call<{ id: string; url: string; origin: string }>("browser:page-url", [{ url }]);
      lease = result.id;
      if (disposed) {
        void client.call("browser:release-page-url", [{ id: lease }]).catch(() => {});
        return null;
      }
      return { uri: result.url, origin: result.origin, external: result.url };
    };
    void Promise.resolve()
      .then(() => {
        if (disposed) return null;
        setError("");
        setRoute(null);
        return open();
      })
      .then(
        (result) => {
          if (!disposed && result) {
            setRoute(result);
            latest.current.onExternalUrl(result.external);
          }
        },
        (failure) => {
          if (!disposed) setError(failure instanceof Error ? failure.message : "Could not reach this page.");
        },
      );
    return () => {
      disposed = true;
      clearInterval(heartbeat);
      subscription.remove();
      latest.current.onExternalUrl(null);
      if (lease) void client.call("browser:release-page-url", [{ id: lease }]).catch(() => {});
    };
  }, [client, url, host, forceProxy, attempt]);
  useEffect(() => {
    if (!route) return;
    const timer = setTimeout(() => {
      if (ready.current) return;
      if (!forceProxy && privatePage(url)) setForceProxy(true);
      else setError("The page did not load. Check that its server is running, then retry.");
    }, 20_000);
    return () => clearTimeout(timer);
  }, [route, forceProxy, url]);
  useEffect(() => {
    if (!commenting || picked) {
      view.current?.injectJavaScript(PAGE_PICK_CANCEL + ";true;");
      return;
    }
    view.current?.injectJavaScript(
      `Promise.resolve(${pagePickScript()}).then(element => window.ReactNativeWebView.postMessage(JSON.stringify({kind:'pick',element})));true;`,
    );
    const current = view.current;
    return () => current?.injectJavaScript(PAGE_PICK_CANCEL + ";true;");
  }, [commenting, picked]);
  if (error)
    return (
      <View style={{ padding: 16 }}>
        <ErrorNotice message={error} retryTitle="Retry" retry={() => setAttempt((value) => value + 1)} />
      </View>
    );
  if (!route) return <Text style={[styles.muted, { padding: 16 }]}>Connecting to page...</Text>;
  const failed = () => setError("The page stopped. Retry to reload it.");
  return (
    <View style={{ flex: 1 }}>
      <DomWebView
        key={route.external + attempt}
        ref={view}
        source={{ uri: route.uri }}
        style={{ flex: 1 }}
        containerStyle={{ flex: 1 }}
        useExpoModulesBridge={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        injectedJavaScriptBeforeContentLoaded={`(() => {
      // WKWebView has no popup destination. Keep link/form navigation in this page.
      document.addEventListener('click', event => {
        const link = event.target?.closest?.('a[target]');
        if (link && !['_self', '_top', '_parent'].includes(link.target.toLowerCase())) link.target = '_self';
      }, true);
      document.addEventListener('submit', event => { if (event.target?.target) event.target.target = '_self'; }, true);
      window.open = function(url) {
        if (url) {
          const destination = new URL(url, location.href);
          if (/^https?:$/.test(destination.protocol)) location.assign(destination.href);
        }
        return window;
      };
    })();true;`}
        injectedJavaScript={`(() => {
      if (window.top !== window) return;
      const report = () => window.ReactNativeWebView.postMessage(JSON.stringify({kind:'page',url:location.href,title:document.title}));
      report(); addEventListener('pageshow', report); addEventListener('popstate', report); addEventListener('hashchange', report);
      for (const name of ['pushState','replaceState']) { const original = history[name]; history[name] = function(...args) { const result = original.apply(this,args); report(); return result; }; }
      new MutationObserver(report).observe(document.querySelector('title') || document.head, {subtree:true,childList:true,characterData:true});
    })();true;`}
        onMessage={(event) => {
          try {
            const message = JSON.parse(event.nativeEvent.data);
            if (message.kind === "page" && typeof message.url === "string" && /^https?:\/\//i.test(message.url)) {
              ready.current = true;
              // The native WebView compares its source with its current URL on prop updates. Follow navigation so a
              // title/comment render cannot reload the initial address (or the tunnel's bootstrap redirect).
              setRoute((current) => (current && current.uri !== message.url ? { ...current, uri: message.url } : current));
              const address = originalPageUrl(message.url, url, route.origin);
              latest.current.onPage({ title: String(message.title ?? ""), url: address });
              // An external browser needs its own authentication cookie; always enter a proxy through its login URL.
              latest.current.onExternalUrl(forceProxy || !directPageUrl(url, host) ? externalPageUrl(message.url, route.external, route.origin) : message.url);
            } else if (message.kind === "pick" && commenting && !picked && message.element?.selector && message.element?.box)
              latest.current.onPick(message.element);
          } catch {
            /* Web content cannot issue RPCs. Only a page title/address or a picked element is read. */
          }
        }}
        onContentProcessDidTerminate={failed}
        onRenderProcessGone={failed}
      />
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 16, paddingVertical: 6 }}>
        <CircleButton label="Back" icon={ArrowLeft01Icon} onPress={() => view.current?.injectJavaScript("history.back();true;")} />
        <CircleButton label="Forward" icon={ArrowRight01Icon} onPress={() => view.current?.injectJavaScript("history.forward();true;")} />
        <CircleButton label="Reload page" icon={Refresh01Icon} onPress={() => view.current?.reload()} />
      </View>
    </View>
  );
}
