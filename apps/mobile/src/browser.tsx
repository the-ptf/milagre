import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Linking, Platform, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import * as Clipboard from "expo-clipboard";
import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BrowserIcon,
  Cancel01Icon,
  CommentAdd01Icon,
  LaptopIcon,
  Layers01Icon,
  MoreHorizontalIcon,
  Refresh01Icon,
  Sent02Icon,
  WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import type { BrowserList, BrowserTarget } from "@milagre/shared/browser";
import { PAGE_PICK_CANCEL, pagePickScript, pagePinsScript, type PagePin } from "@milagre/shared/page-picker";
import { pageKey, type PageElement, type SavedPageComment } from "@milagre/shared/page-comments";
import { loopbackOnlyPorts } from "@milagre/shared/loopback-url";
import { directPageUrl, externalPageUrl, originalPageUrl, pairedPageHost, privatePage } from "./browser-page-url";
import type { Client } from "./client";
import { useSession } from "./session";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { announce, CircleButton, EmptyState, ErrorNotice, Field, PageScroll, PillButton, PullDown, SheetHeader, useStyles, type MenuSection } from "./ui";
import { over } from "@milagre/shared/themes";
import { lineHeight, radius, type } from "./design-tokens";
import type { ChatTab } from "./panel-tabs";
import { useReachableHost } from "./routes-native";
import type { AgentPort } from "@milagre/shared/model";

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

/**
 * The Chat's servers that answer on the Mac's loopback alone (Vite's default): the phone can't reach them on the Mac's
 * address, so their pages go through the Mac from the start instead of timing out first.
 */
function useLoopbackOnlyPorts(client: Client | null, chatId: string | undefined, visible: boolean) {
  const [ports, setPorts] = useState<AgentPort[]>([]);
  useEffect(() => {
    if (!client || !chatId || !visible) return;
    let disposed = false;
    client.call<{ chatId: string; ports: AgentPort[] }>("chat:ports", [chatId]).then(
      (result) => {
        if (!disposed && result?.chatId === chatId) setPorts(result.ports);
        return undefined;
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [client, chatId, visible]);
  return useMemo(() => loopbackOnlyPorts(ports), [ports]);
}

/** A comment written in comment mode, waiting for Send with the others. */
type Draft = { key: string; page: { url: string; title: string }; element: PageElement; text: string };
/** What the comment box shows: a new comment on a picked element, a waiting one, or a sent one to read. */
type Box = { kind: "new"; element: PageElement } | { kind: "draft"; key: string } | { kind: "sent"; id: string };

// Waiting comments outlive the sheet: closing the Browser and opening it again keeps them, per Chat.
const draftsByChat = new Map<string, Draft[]>();
let draftKey = 0;

/** The page a Browser view loads, and what its WebView can do. */
type PageControls = { back(): void; forward(): void; reload(): void; viaMac(): void; viaMacAvailable: boolean };

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
  // In the panel docked beside the Chat (an iPad) the toolbar is one row; full screen (a phone) it is a header.
  const docked = onClose !== goBack;
  const source = client && (!hostId || hostId === client.url) ? client : null;
  const { list } = useBrowsers(source, chatId, visible);
  const loopbackOnly = useLoopbackOnlyPorts(source, chatId, visible);
  // Each link is a local page, even when the host has no desktop window open.
  const requested = url ? { id: `link:${requestId ?? url}`, title: "", url, browser: "Browser", source: "panel" as const } : null;
  const linkKey = `${hostId}:${chatId}:${url}:${requestId}`;
  const [lastLink, setLastLink] = useState(linkKey);
  const [chosen, setChosen] = useState<BrowserTarget | null>(requested);
  const [page, setPage] = useState<{ title: string; url: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const resetComments = () => {
    setCommenting(false);
    setBox(null);
  };
  if (lastLink !== linkKey) {
    setLastLink(linkKey);
    setChosen(requested);
    setPage(null);
    setChoosing(false);
    resetComments();
  }
  const automatic = !choosing && list?.targets.length === 1 ? list.targets[0] : null;
  if (lastLink === linkKey && !chosen && automatic) setChosen({ ...automatic });
  const selected = choosing ? null : (chosen ?? automatic);
  // The pages to switch between: the agent's, plus a link opened from the Chat.
  const pages = [...(requested && !list?.targets.some((target) => target.url === requested.url) ? [requested] : []), ...(list?.targets ?? [])];
  const shown = selected ? (page ?? { title: selected.title, url: selected.url }) : null;
  const reachableHost = useReachableHost(source?.url) ?? pairedPageHost(source?.url);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [controls, setControls] = useState<PageControls | null>(null);
  const [loaded, setLoaded] = useState(false);

  const chatKey = `${source?.url}|${chatId}`;
  const [drafts, setDraftsState] = useState<Draft[]>(() => draftsByChat.get(chatKey) ?? []);
  const setDrafts = (update: (current: Draft[]) => Draft[]) =>
    setDraftsState((current) => {
      const next = update(current);
      draftsByChat.set(chatKey, next);
      return next;
    });
  const [sent, setSent] = useState<SavedPageComment[]>([]);
  const loadSent = useCallback(async () => {
    if (!source || !chatId) return;
    try {
      setSent(await source.call<SavedPageComment[]>("browser-comments:list", [{ chatId }]));
    } catch {
      /* Pins of sent comments are a nicety; the page still works without them. */
    }
  }, [source, chatId]);
  useEffect(() => {
    if (!visible || !source || !chatId) return;
    let disposed = false;
    source.call<SavedPageComment[]>("browser-comments:list", [{ chatId }]).then(
      (comments) => {
        if (!disposed) setSent(comments);
        return undefined;
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [visible, source, chatId]);
  const [sending, setSending] = useState(false);

  const here = shown ? pageKey(shown.url) : "";
  const pageDrafts = drafts.filter((draft) => pageKey(draft.page.url) === here);
  const pageSent = sent.filter((comment) => pageKey(comment.url) === here);
  const pins: PagePin[] = [
    ...pageSent.map((comment, index) => ({
      n: index + 1,
      id: `sent:${comment.id}`,
      selector: comment.selector,
      point: comment.point,
      text: comment.text,
      state: comment.resolved ? ("resolved" as const) : ("open" as const),
      note: comment.resolved?.note,
    })),
    ...pageDrafts.map((draft, index) => ({
      n: pageSent.length + index + 1,
      id: `draft:${draft.key}`,
      selector: draft.element.selector,
      point: draft.element.point,
      text: draft.text,
      state: "pending" as const,
    })),
    ...(box?.kind === "new"
      ? [{ n: pageSent.length + pageDrafts.length + 1, selector: box.element.selector, point: box.element.point, text: "", state: "pending" as const }]
      : []),
  ];

  const send = async () => {
    if (!source || !chatId || !drafts.length || sending) return;
    setSending(true);
    const batch = drafts;
    try {
      const comments = batch.map((draft) => ({ page: { ...draft.page, element: draft.element }, text: draft.text }));
      try {
        await source.call("browser-comments:send-from-page", [{ chatId, comments }]);
      } catch (error) {
        // A Mac from before batches reads `text` only: send them one by one.
        if (!(error instanceof Error) || error.message !== "Write the comment first.") throw error;
        for (const comment of comments) await source.call("browser-comments:send-from-page", [{ chatId, ...comment }]);
      }
      const keys = new Set(batch.map((draft) => draft.key));
      setDrafts((current) => current.filter((draft) => !keys.has(draft.key)));
      setCommenting(false);
      announce(batch.length === 1 ? "Comment sent to the agent." : `${batch.length} comments sent to the agent.`);
      void loadSent();
    } catch (error) {
      Alert.alert("The comments didn't send", error instanceof Error ? error.message : "Try again.");
    } finally {
      setSending(false);
    }
  };

  const openExternally = () => {
    if (externalUrl) void Linking.openURL(externalUrl).catch(() => Alert.alert("Could not open this page", "Try opening the page again."));
  };
  const copyLink = () => {
    if (!shown) return;
    void Clipboard.setStringAsync(shown.url).then(() => announce("Link copied."));
  };
  const openPages = () => {
    resetComments();
    setChoosing(true);
    setPage(null);
  };
  const toggleComments = () => {
    setBox(null);
    setCommenting((on) => !on);
  };
  const menu: MenuSection[] = selected
    ? [
        ...(docked
          ? []
          : [
              {
                items: [
                  { id: "back", title: "Back", systemImage: "chevron.backward" },
                  { id: "forward", title: "Forward", systemImage: "chevron.forward" },
                  { id: "reload", title: "Reload", systemImage: "arrow.clockwise" },
                ],
              },
            ]),
        {
          items: [
            { id: "copy", title: "Copy link", systemImage: "link" },
            { id: "safari", title: "Open in Safari", systemImage: "safari", disabled: !externalUrl },
            ...(controls?.viaMacAvailable ? [{ id: "mac", title: "Load through Mac", systemImage: "desktopcomputer" }] : []),
          ],
        },
        ...(pages.length > 1 && docked
          ? []
          : pages.length > 1
            ? [{ items: [{ id: "pages", title: `All pages (${pages.length})`, systemImage: "square.on.square" }] }]
            : []),
      ]
    : [];
  const onMenu = (id: string) => {
    if (id === "back") controls?.back();
    else if (id === "forward") controls?.forward();
    else if (id === "reload") controls?.reload();
    else if (id === "copy") copyLink();
    else if (id === "safari") openExternally();
    else if (id === "mac") controls?.viaMac();
    else if (id === "pages") openPages();
  };

  const commentButton = selected && loaded && (
    <CircleButton
      key="comment"
      label={commenting ? "Stop commenting" : "Comment on the page"}
      icon={CommentAdd01Icon}
      selected={commenting}
      onPress={toggleComments}
    />
  );
  const sendButton = drafts.length > 0 && (
    <CircleButton
      key="send"
      label={`Send ${drafts.length} ${drafts.length === 1 ? "comment" : "comments"} to the agent`}
      icon={Sent02Icon}
      filled
      badge={drafts.length}
      disabled={sending}
      onPress={() => void send()}
    />
  );
  const moreButton = selected && (
    <PullDown key="more" label="Page actions" sections={menu} onSelect={onMenu}>
      <CircleButton label="Page actions" icon={MoreHorizontalIcon} asTrigger />
    </PullDown>
  );
  const pagesButton = pages.length > 1 && (
    <CircleButton
      key="pages"
      label={`All pages, ${pages.length}`}
      icon={Layers01Icon}
      selected={choosing}
      onPress={choosing ? () => setChoosing(false) : openPages}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: docked ? 0 : insets.top }}>
      {/* Keep the header as one native view: form-sheet scroll sizing cannot account for a flattened header. */}
      <View collapsable={false} style={{ flexShrink: 0 }}>
        {docked ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingTop: 12, paddingBottom: 8 }}>
            {selected && <CircleButton label="Back" icon={ArrowLeft01Icon} onPress={controls ? () => controls.back() : undefined} />}
            {selected && <CircleButton label="Forward" icon={ArrowRight01Icon} onPress={controls ? () => controls.forward() : undefined} />}
            {pagesButton}
            <View
              accessible
              accessibilityRole="header"
              accessibilityLabel={shown ? `${shown.title}, ${shown.url}` : "Browser"}
              style={{
                flex: 1,
                minWidth: 0,
                height: 40,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingLeft: 12,
                paddingRight: 4,
                borderRadius: radius.control,
                borderCurve: "continuous",
                backgroundColor: colors.field,
              }}
            >
              <Text
                numberOfLines={1}
                ellipsizeMode="middle"
                style={{ flex: 1, color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}
              >
                {shown?.url || (choosing ? "All pages" : "Browser")}
              </Text>
              {selected && (
                <Pressable accessibilityRole="button" accessibilityLabel="Reload page" hitSlop={8} onPress={() => controls?.reload()} style={{ padding: 6 }}>
                  <Icon icon={Refresh01Icon} size={16} tone="ink2" />
                </Pressable>
              )}
            </View>
            {commentButton}
            {sendButton}
            {moreButton}
            <CircleButton label="Close browser" icon={Cancel01Icon} onPress={onClose} />
          </View>
        ) : (
          <SheetHeader
            title={choosing ? "All pages" : shown?.title || "Browser"}
            subtitle={choosing ? `${pages.length} ${pages.length === 1 ? "page" : "pages"} in this Chat` : shown?.url || "This Chat"}
            subtitleEllipsis={shown?.url ? "middle" : "tail"}
            leading={[<CircleButton key="close" label="Close browser" icon={Cancel01Icon} onPress={onClose} />, pagesButton].filter(Boolean)}
            trailing={[commentButton, sendButton, moreButton].filter(Boolean)}
          />
        )}
      </View>
      <View collapsable={false} style={{ flex: 1, minHeight: 0 }}>
        {!visible ? null : !source || !chatId ? (
          <Text style={[styles.muted, { padding: 16 }]}>Reconnect to this computer to open its browsers.</Text>
        ) : selected ? (
          <KeyboardAvoidingView behavior="padding" enabled={!!box} style={{ flex: 1, minHeight: 0 }}>
            <BrowserWebView
              key={`page:${selected.id}`}
              client={source}
              url={selected.url}
              host={reachableHost}
              loopbackOnly={loopbackOnly}
              onExternalUrl={setExternalUrl}
              onControls={setControls}
              onLoaded={setLoaded}
              onPage={(next) => {
                if (page && page.url !== next.url) setBox(null);
                setPage(next);
              }}
              picking={commenting && !box}
              pins={pins}
              onPick={(element) => setBox({ kind: "new", element })}
              onPin={(id) => {
                if (id.startsWith("draft:")) setBox({ kind: "draft", key: id.slice("draft:".length) });
                else if (id.startsWith("sent:")) setBox({ kind: "sent", id: id.slice("sent:".length) });
              }}
            />
            {commenting && !box && <CommentHint bottom={insets.bottom} count={pageDrafts.length} onDone={() => setCommenting(false)} />}
            {box && shown && (
              <PageCommentBox
                key={box.kind === "new" ? box.element.selector : box.kind === "draft" ? box.key : box.id}
                box={box}
                bottom={insets.bottom}
                draft={box.kind === "draft" ? drafts.find((draft) => draft.key === box.key) : undefined}
                sentComment={box.kind === "sent" ? sent.find((comment) => comment.id === box.id) : undefined}
                onAdd={(text) => {
                  if (box.kind !== "new") return;
                  setDrafts((current) => [...current, { key: String(++draftKey), page: shown, element: box.element, text }]);
                  setBox(null);
                }}
                onChange={(text) => {
                  if (box.kind === "draft") setDrafts((current) => current.map((draft) => (draft.key === box.key ? { ...draft, text } : draft)));
                }}
                onDelete={() => {
                  if (box.kind === "draft") setDrafts((current) => current.filter((draft) => draft.key !== box.key));
                  setBox(null);
                }}
                onClose={() => setBox(null)}
              />
            )}
          </KeyboardAvoidingView>
        ) : (
          <PageScroll
            style={{ flex: 1 }}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustContentInsets={false}
            contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: insets.bottom + 16 }}
          >
            {!list && !pages.length && <Text style={styles.muted}>{"Finding this Chat's pages…"}</Text>}
            {!!list?.error && <ErrorNotice message={list.error} />}
            {list?.supported === false && <Text style={styles.muted}>Browsers are unavailable on this computer.</Text>}
            {list && !list.error && !pages.length && (
              <EmptyState icon={BrowserIcon} title="No pages in this Chat yet">
                Pages the agent opens and links you tap in the Chat show here.
              </EmptyState>
            )}
            {pages.map((target) => {
              const current = (chosen ?? automatic)?.id === target.id;
              return (
                <Pressable
                  key={target.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: current }}
                  accessibilityLabel={`${target.title || target.url}, ${target.url}`}
                  onPress={() => {
                    setChosen(target);
                    setPage(null);
                    setChoosing(false);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    padding: 12,
                    gap: 12,
                    borderRadius: radius.control,
                    borderCurve: "continuous",
                    borderWidth: current ? 1.5 : 0,
                    borderColor: colors.accent,
                    backgroundColor: pressed ? over(colors.hover, colors.page) : colors.page,
                  })}
                >
                  <Icon icon={BrowserIcon} size={18} tone="ink2" />
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
                      {target.title || target.url}
                    </Text>
                    <Text numberOfLines={1} ellipsizeMode="middle" style={styles.muted}>
                      {target.url}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </PageScroll>
        )}
      </View>
    </View>
  );
}

/** Comment mode's prompt at the bottom of the page, until an element is tapped. */
function CommentHint({ bottom, count, onDone }: { bottom: number; count: number; onDone(): void }) {
  const { colors } = useTheme();
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: bottom + 16, alignItems: "center" }}>
      <View
        accessibilityLiveRegion="polite"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingLeft: 16,
          paddingRight: 6,
          paddingVertical: 6,
          borderRadius: radius.full,
          backgroundColor: colors.ink,
          boxShadow: colors.shadowRaised,
        }}
      >
        <Text style={{ color: colors.page, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
          {count ? `Tap another element · ${count} waiting` : "Tap an element to comment"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop commenting"
          onPress={onDone}
          style={({ pressed }) => ({
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: radius.full,
            backgroundColor: over(pressed ? "#ffffff33" : "#ffffff1f", colors.ink),
          })}
        >
          <Text style={{ color: colors.page, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The comment box, docked at the bottom of the page above the keyboard so the picked element stays in view: a new
 * comment (Add queues it for Send), a waiting one (edit or Delete), or a sent one to read with the agent's note.
 */
function PageCommentBox({
  box,
  bottom,
  draft,
  sentComment,
  onAdd,
  onChange,
  onDelete,
  onClose,
}: {
  box: Box;
  bottom: number;
  draft?: Draft;
  sentComment?: SavedPageComment;
  onAdd(text: string): void;
  onChange(text: string): void;
  onDelete(): void;
  onClose(): void;
}) {
  const { colors } = useTheme();
  const [text, setText] = useState(draft?.text ?? "");
  const label = box.kind === "new" ? box.element.label : box.kind === "draft" ? draft?.element.label : sentComment?.label;
  return (
    <View
      accessibilityViewIsModal
      onAccessibilityEscape={box.kind === "new" ? onDelete : onClose}
      style={{
        marginHorizontal: 12,
        marginBottom: 8 + (Platform.OS === "ios" ? 0 : bottom),
        padding: 14,
        gap: 10,
        borderRadius: radius.card,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.lineStrong,
        backgroundColor: colors.surface,
        boxShadow: colors.shadowRaised,
      }}
    >
      {!!label && (
        <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
          {label}
        </Text>
      )}
      {box.kind === "sent" ? (
        <>
          <Text selectable style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body }}>
            {sentComment?.text ?? "This comment is no longer on the computer."}
          </Text>
          <Text style={{ color: sentComment?.resolved ? colors.greenInk : colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
            {sentComment?.resolved ? `Resolved · ${sentComment.resolved.note}` : "Sent · waiting for the agent"}
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <PillButton size="small" secondary title="Close" onPress={onClose} />
          </View>
        </>
      ) : (
        <>
          <Field
            label="Comment"
            hideLabel
            autoFocus
            multiline
            autoCapitalize="sentences"
            autoCorrect
            defaultValue={draft?.text ?? ""}
            onChangeText={(value) => {
              setText(value);
              onChange(value);
            }}
            placeholder="What should change here?"
            style={{ maxHeight: 120 }}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            {box.kind === "new" ? (
              <PillButton size="small" variant="plain" muted title="Cancel" onPress={onDelete} />
            ) : (
              <PillButton size="small" variant="plain" destructive title="Delete" onPress={onDelete} />
            )}
            <PillButton
              size="small"
              title={box.kind === "new" ? "Add" : "Done"}
              disabled={!text.trim()}
              onPress={() => (box.kind === "new" ? onAdd(text.trim()) : onClose())}
            />
          </View>
        </>
      )}
    </View>
  );
}

type Route = { uri: string; origin: string; external: string; via: "direct" | "mac" };

function BrowserWebView({
  client,
  url,
  host,
  loopbackOnly,
  onPage,
  onExternalUrl,
  onControls,
  onLoaded,
  picking,
  pins,
  onPick,
  onPin,
}: {
  client: Client;
  url: string;
  host: string | null;
  loopbackOnly: ReadonlySet<number>;
  onPage(page: { title: string; url: string }): void;
  onExternalUrl(url: string | null): void;
  onControls(controls: PageControls | null): void;
  onLoaded(loaded: boolean): void;
  picking: boolean;
  pins: PagePin[];
  onPick(element: PageElement): void;
  onPin(id: string): void;
}) {
  const { colors } = useTheme();
  const view = useRef<DomWebViewRef>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [forceProxy, setForceProxy] = useState(false);
  const ready = useRef(false);
  const armedAt = useRef("");
  const latest = useRef({ onPage, onPick, onPin, onExternalUrl, onLoaded, picking, pins, accent: colors.accent, green: colors.green });
  useEffect(() => {
    latest.current = { onPage, onPick, onPin, onExternalUrl, onLoaded, picking, pins, accent: colors.accent, green: colors.green };
  });
  // The route is chosen when the page opens. A network change afterwards (Wi-Fi to cellular, the LAN check flipping)
  // must not tear down a working page and its tunnel; Retry and Load through Mac choose again.
  const routing = useRef({ host, loopbackOnly });
  useEffect(() => {
    if (!route && !error) routing.current = { host, loopbackOnly };
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
    latest.current.onLoaded(false);
    const { host: routeHost, loopbackOnly: loopback } = routing.current;
    const direct = !forceProxy && directPageUrl(url, routeHost, loopback);
    const open = async (): Promise<Route | null> => {
      if (!/^https?:\/\//i.test(url)) throw new Error("Only HTTP and HTTPS pages open in Browser.");
      if (direct) return { uri: direct, origin: new URL(direct).origin, external: direct, via: "direct" };
      const result = await client.call<{ id: string; url: string; origin: string }>("browser:page-url", [{ url }]);
      lease = result.id;
      if (disposed) {
        void client.call("browser:release-page-url", [{ id: lease }]).catch(() => {});
        return null;
      }
      return { uri: result.url, origin: result.origin, external: result.url, via: "mac" };
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
  }, [client, url, forceProxy, attempt]);
  useEffect(() => {
    if (!route) return;
    const timer = setTimeout(() => {
      if (ready.current) return;
      // A direct address to the Mac's network that doesn't answer goes through the Mac on its own.
      if (route.via === "direct" && privatePage(url)) setForceProxy(true);
      else setError(route.via === "mac" ? "The page didn't load through the Mac. Check that its server is running, then retry." : "The page didn't load.");
    }, 20_000);
    return () => clearTimeout(timer);
  }, [route, url]);
  const viaMac = useCallback(() => {
    setError("");
    setRoute(null);
    setForceProxy(true);
    setAttempt((value) => value + 1);
  }, []);
  const retry = useCallback(() => {
    setError("");
    setRoute(null);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    onControls({
      back: () => view.current?.injectJavaScript("history.back();true;"),
      forward: () => view.current?.injectJavaScript("history.forward();true;"),
      reload: () => (error ? retry() : view.current?.reload()),
      viaMac,
      viaMacAvailable: !forceProxy && (route?.via === "direct" || (!route && !!error)),
    });
  }, [onControls, viaMac, retry, error, forceProxy, route]);
  useEffect(() => () => onControls(null), [onControls]);
  // The picker and pins live in the page, which forgets them on every load: arm them again whenever it reports in.
  const arm = useCallback(() => {
    const current = view.current;
    if (!current || !ready.current) return;
    const { picking: on, pins: shown, accent, green } = latest.current;
    current.injectJavaScript(`${pagePinsScript(shown, { accent, green })};true;`);
    if (on)
      current.injectJavaScript(
        `Promise.resolve(${pagePickScript(accent)}).then(element => { if (element) window.ReactNativeWebView.postMessage(JSON.stringify({kind:'pick',element})); });true;`,
      );
    else current.injectJavaScript(PAGE_PICK_CANCEL + ";true;");
  }, []);
  const pinsKey = JSON.stringify(pins);
  useEffect(arm, [arm, picking, pinsKey]);
  if (error)
    return (
      <PageError
        url={url}
        message={error}
        viaMac={!forceProxy && privatePage(url) ? viaMac : undefined}
        retry={retry}
        openExternally={() => void Linking.openURL(url).catch(() => {})}
      />
    );
  if (!route)
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
        <ActivityIndicator color={colors.ink3} />
        <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
          {forceProxy || !directPageUrl(url, host, loopbackOnly) ? "Opening through your Mac…" : "Connecting to page…"}
        </Text>
      </View>
    );
  const failed = () => setError("The page stopped. Retry to reload it.");
  return (
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
      window.__milagrePinTap = id => window.ReactNativeWebView.postMessage(JSON.stringify({kind:'pin',id:String(id)}));
      const report = (fresh) => window.ReactNativeWebView.postMessage(JSON.stringify({kind:'page',url:location.href,title:document.title,fresh:fresh === true}));
      report(true); addEventListener('pageshow', () => report(true)); addEventListener('popstate', report); addEventListener('hashchange', report);
      for (const name of ['pushState','replaceState']) { const original = history[name]; history[name] = function(...args) { const result = original.apply(this,args); report(); return result; }; }
      new MutationObserver(report).observe(document.querySelector('title') || document.head, {subtree:true,childList:true,characterData:true});
    })();true;`}
      onMessage={(event) => {
        try {
          const message = JSON.parse(event.nativeEvent.data);
          if (message.kind === "page" && typeof message.url === "string" && /^https?:\/\//i.test(message.url)) {
            const first = !ready.current;
            ready.current = true;
            if (first) latest.current.onLoaded(true);
            // The native WebView compares its source with its current URL on prop updates. Follow navigation so a
            // title/comment render cannot reload the initial address (or the tunnel's bootstrap redirect).
            setRoute((current) => (current && current.uri !== message.url ? { ...current, uri: message.url } : current));
            const address = originalPageUrl(message.url, url, route.origin);
            latest.current.onPage({ title: String(message.title ?? ""), url: address });
            // An external browser needs its own authentication cookie; always enter a proxy through its login URL.
            latest.current.onExternalUrl(route.via === "mac" ? externalPageUrl(message.url, route.external, route.origin) : message.url);
            if (message.fresh === true || armedAt.current !== message.url) {
              armedAt.current = message.url;
              arm();
            }
          } else if (message.kind === "pick" && latest.current.picking && message.element?.selector && message.element?.box)
            latest.current.onPick(message.element);
          else if (message.kind === "pin" && typeof message.id === "string") latest.current.onPin(message.id);
        } catch {
          /* Web content cannot issue RPCs. Only a page title/address, a picked element or a tapped pin is read. */
        }
      }}
      onContentProcessDidTerminate={failed}
      onRenderProcessGone={failed}
    />
  );
}

/** A page that didn't load: what happened, and the ways out (through the Mac, again, or in Safari). */
function PageError({
  url,
  message,
  viaMac,
  retry,
  openExternally,
}: {
  url: string;
  message: string;
  viaMac?: () => void;
  retry(): void;
  openExternally(): void;
}) {
  const { colors } = useTheme();
  let address = url;
  try {
    address = new URL(url).host;
  } catch {
    /* Shown as written. */
  }
  return (
    <PageScroll contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 14 }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: colors.field }}>
        <Icon icon={WifiDisconnected01Icon} size={26} tone="ink2" />
      </View>
      <Text style={{ color: colors.ink, fontSize: type.title3, lineHeight: lineHeight.title3, fontWeight: "600", textAlign: "center" }}>
        {`${address} didn't load`}
      </Text>
      <Text selectable style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, textAlign: "center", maxWidth: 320 }}>
        {message}
      </Text>
      <View style={{ gap: 10, alignSelf: "stretch", alignItems: "center", paddingTop: 6 }}>
        {viaMac && <PillButton title="Load through Mac" icon={LaptopIcon} onPress={viaMac} style={{ minWidth: 240 }} />}
        <PillButton title="Retry" icon={Refresh01Icon} secondary={!!viaMac} onPress={retry} style={{ minWidth: 240 }} />
        <PillButton title="Open in Safari" variant="plain" onPress={openExternally} />
      </View>
    </PageScroll>
  );
}
