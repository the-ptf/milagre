import { commentActivity } from "./comment-activity";
import { HtmlReply } from "./html-reply";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import { ArrowRight01Icon, Cancel01Icon, CheckmarkCircle02Icon, CommentAdd01Icon, File01Icon, PaintBoardIcon, Sent02Icon } from "@hugeicons/core-free-icons";
import {
  artifactShell,
  artifactTab,
  designFeedbackMessage,
  designFeedbackText,
  newCommentId,
  onArtifactTab,
  artifactDownload,
  sentNumbers,
  type Artifact,
  type ArtifactComment,
  type DesignComment,
  type PagePin,
  resolutionNotes,
} from "@milagre/shared/artifact";
import type { ArtifactRef } from "@milagre/shared/model";
import type { ArtifactStep } from "@milagre/shared/reply-parts";
import { postDesignMessage, sendDesignMessageNow } from "./design-outbox";
import { usePanelTabs, type DesignsTab } from "./panel-tabs";
import { File, Paths } from "expo-file-system";
import { useSession } from "./session";
import { useArtifactCatalog } from "./use-design-catalog";
import { Icon } from "./icons";
import { over } from "@milagre/shared/themes";
import { lineHeight, radius, space, type } from "./design-tokens";
import { DISABLED_OPACITY } from "./primitives/press-style";
import { CircleButton, ErrorNotice, PillButton, tap, useStyles } from "./ui";
import { useTheme } from "./theme";
import { PELE_SCRIPT } from "./pele-script";
import { useShareAvailable } from "./use-share-available";
import { ArtifactPageTitle, artifactPageMenu, useChatDesigns } from "./artifact-page-menu";
import { useDesignLibrary } from "./design-library";
import { artifactPageActions } from "./artifact-page-actions";
import { readArtifactEvent, rememberPage, rememberedTab } from "./artifact-pages";
import { pageWithFiles, usePageFiles } from "./artifact-files";
import { CommentBox } from "./viewer-chrome";
import { CommentNumber } from "./feedback-comment-number";
import { useVisibleRunChatKeys } from "./visible-run-chats";

let feedbackRequestId = 0;

export function DesignFeedbackCard({
  feedback,
  chatId,
  moved = 0,
  renderImages,
}: {
  feedback: { choice: ArtifactRef | null; comments: DesignComment[] };
  chatId?: string;
  moved?: number;
  renderImages?: (numbers: number[]) => ReactNode;
}) {
  const { colors } = useTheme();
  const { client, designs: feature } = useSession();
  const openTab = usePanelTabs();
  const format = useArtifactCatalog(
    client,
    chatId,
    [...(feedback.choice ? [feedback.choice] : []), ...feedback.comments.map((comment) => comment.design)],
    feature.enabled === true,
  );
  const choice = feedback.choice && format(feedback.choice) ? feedback.choice : null;
  const comments = feedback.comments.filter((comment) => format(comment.design));
  const plain = designFeedbackText({
    choice: feedback.choice && !choice ? feedback.choice : null,
    comments: feedback.comments.filter((comment) => !format(comment.design)),
  });
  const feedbackLabel = [...(choice ? [choice] : []), ...comments.map((comment) => comment.design)].some((ref) => format(ref) === "html")
    ? "Feedback on the artifact"
    : "Feedback on the designs";
  const [resolutions, setResolutions] = useState<Map<string, string>>(() => new Map());
  const ids = comments.some((comment) => comment.id);
  useEffect(() => {
    if (!client || !chatId || !ids) return;
    let live = true;
    client
      .call<ArtifactComment[]>("artifact:comments", [{ chatId }])
      .then((comments) => live && setResolutions(resolutionNotes(comments)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, chatId, ids, moved]);
  if (!choice && !comments.length)
    return (
      <Text selectable style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
        {designFeedbackText(feedback)}
      </Text>
    );
  return (
    <View style={{ gap: space.md }}>
      <View
        accessibilityLabel={feedbackLabel}
        style={{
          minWidth: 240,
          borderRadius: radius.sheet,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.line,
          backgroundColor: colors.surface,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingHorizontal: space.xl,
            paddingVertical: space.md,
            borderBottomWidth: 1,
            borderColor: colors.line,
          }}
        >
          <Icon icon={PaintBoardIcon} tone="ink2" size={12} />
          <Text style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>{feedbackLabel}</Text>
        </View>
        {choice && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingHorizontal: space.xl,
              paddingVertical: space.lg,
            }}
          >
            <Icon icon={CheckmarkCircle02Icon} tone="accent" size={16} />
            <Text style={{ flex: 1, color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }} numberOfLines={1}>
              Chose {choice.title}
            </Text>
            <Text style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
              {format(choice) === "design" ? `v${choice.version}` : "Artifact"}
            </Text>
          </View>
        )}
        {comments.map((comment, index) => {
          const resolved = comment.id ? resolutions.get(comment.id) : undefined;
          const openable = !!format(comment.design) && !!client && !!chatId && !chatId.includes("#new:");
          return (
            <Pressable
              key={index}
              accessibilityRole={openable ? "button" : undefined}
              accessibilityLabel={openable ? `Open comment ${index + 1} on ${comment.tab?.title ?? comment.design.title}` : undefined}
              disabled={!openable}
              onPress={() => {
                if (!openable) return;
                openDesigns(openTab, {
                  hostId: client.url,
                  chatId,
                  id: comment.design.id,
                  html: format(comment.design) === "html",
                  version: String(comment.design.version),
                  tab: comment.tab?.id,
                  comment: comment.id,
                  requestId: String(++feedbackRequestId),
                });
              }}
              style={{
                flexDirection: "row",
                gap: space.lg,
                paddingHorizontal: space.xl,
                paddingVertical: space.lg,
                borderTopWidth: 1,
                borderColor: colors.line,
              }}
            >
              <CommentNumber number={index + 1} resolved={resolved !== undefined} />
              <View style={{ flex: 1, gap: space.xxs }}>
                <Text
                  selectable
                  style={{
                    color: resolved === undefined ? colors.ink : colors.ink3,
                    fontSize: type.subheadline,
                    lineHeight: lineHeight.subheadline,
                    textDecorationLine: resolved === undefined ? "none" : "line-through",
                  }}
                >
                  {comment.text}
                </Text>
                {comment.images && renderImages?.(comment.images)}
                {resolved !== undefined && (
                  <View
                    accessibilityLabel={`Resolved: ${resolved}`}
                    style={{
                      flexDirection: "row",
                      gap: 4,
                      alignItems: "flex-start",
                    }}
                  >
                    <Icon icon={CheckmarkCircle02Icon} tone="green" size={12} />
                    <Text selectable style={{ flex: 1, color: colors.greenInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
                      {resolved}
                    </Text>
                  </View>
                )}
                <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
                  {comment.design.title}
                  {format(comment.design) === "design" ? ` · v${comment.design.version}` : " · Artifact"}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {plain ? (
        <Text selectable style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
          {plain}
        </Text>
      ) : null}
    </View>
  );
}

export function ArtifactCards({ steps, chatId, chosen }: { steps: ArtifactStep[]; chatId?: string; chosen?: string }) {
  const { colors } = useTheme();
  const { client, designs: feature } = useSession();
  const format = useArtifactCatalog(
    client,
    chatId,
    steps.map((step) => step.artifact),
    feature.enabled === true,
  );
  const openTab = usePanelTabs();
  const inline = steps.filter((step) => step.artifact.inline);
  if (inline.length)
    return (
      <View style={{ gap: 8 }}>
        {inline.map((step) => (
          <HtmlReply key={step.id} chatId={chatId} page={step.artifact} />
        ))}
        <ArtifactCards steps={steps.filter((step) => !step.artifact.inline)} chatId={chatId} chosen={chosen} />
      </View>
    );
  const html = steps.findLast((step) => format(step.artifact) === "html");
  const designs = steps.filter((step) => format(step.artifact) === "design");
  if (html)
    return (
      <View style={{ gap: space.md }}>
        <ArtifactCard step={html} chatId={chatId} kind="html" />
        {designs.length > 0 && <ArtifactCards steps={designs} chatId={chatId} chosen={chosen} />}
      </View>
    );
  steps = designs;
  if (steps.length === 0) return null;
  if (steps.length === 1) return <ArtifactCard step={steps[0]!} chatId={chatId} chosen={chosen} />;
  const first = steps[0]!.artifact;
  const openable = !!client && !!chatId && !chatId.includes("#new:");
  const titles = steps.map((step) => step.artifact.title).join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${steps.length} designs: ${titles}. Open full screen`}
      disabled={!openable}
      onPress={() =>
        openDesigns(openTab, { hostId: client!.url, chatId: chatId!, id: first.id, version: String(first.version), ...(chosen ? { chosen } : {}) })
      }
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.lg,
        padding: space.lg,
        borderRadius: radius.card,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: pressed ? over(colors.hover, colors.surface) : colors.surface,
        opacity: openable ? 1 : DISABLED_OPACITY.row,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: radius.control,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.canvas,
        }}
      >
        <Icon icon={PaintBoardIcon} tone="ink2" size={18} />
      </View>
      <View style={{ flex: 1, gap: space.xxs }}>
        <Text style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" }}>{steps.length} designs</Text>
        <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
          {titles}
        </Text>
      </View>
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </Pressable>
  );
}

/** Opens a page of a Chat's Artifact (its canvas, or its HTML page) in the right panel docked beside it on an iPad, full screen on a phone. */
function openDesigns(openTab: ReturnType<typeof usePanelTabs>, target: DesignsTab) {
  if (openTab) {
    openTab({ kind: "designs", target });
    return;
  }
  const { html, ...params } = target;
  router.push({ pathname: "/artifact-sheet", params: { ...params, ...(html ? { kind: "html" } : {}) } });
}

function ArtifactCard({ step, chatId, chosen, kind = "design" }: { step: ArtifactStep; chatId?: string; chosen?: string; kind?: "design" | "html" }) {
  const { colors } = useTheme();
  const { client, designs: feature } = useSession();
  const openTab = usePanelTabs();
  if (kind === "design" && feature.enabled !== true) return null;
  const { id, version, title } = step.artifact;
  const openable = !!client && !!chatId && !chatId.includes("#new:");
  const isChosen = kind === "design" && chosen === `${id}:${version}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        kind === "html" ? `Artifact ${title}. Open full screen` : `Design ${title}, version ${version}${isChosen ? ", chosen" : ""}. Open full screen`
      }
      disabled={!openable}
      onPress={() =>
        openDesigns(openTab, {
          hostId: client!.url,
          chatId: chatId!,
          id,
          ...(kind === "html" ? { html: true } : { version: String(version) }),
          ...(chosen ? { chosen } : {}),
        })
      }
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.lg,
        padding: space.lg,
        borderRadius: radius.card,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: isChosen ? colors.accent : colors.line,
        backgroundColor: pressed ? over(colors.hover, colors.surface) : colors.surface,
        opacity: openable ? 1 : DISABLED_OPACITY.row,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: radius.control,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.canvas,
        }}
      >
        <Icon icon={kind === "html" ? File01Icon : PaintBoardIcon} tone="ink2" size={18} />
      </View>
      <View style={{ flex: 1, gap: space.xxs }}>
        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" }}>
          {title}
        </Text>
        <Text style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
          {kind === "html" ? "Artifact" : `Design · version ${version}`}
          {isChosen ? " · chosen" : ""}
        </Text>
      </View>
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </Pressable>
  );
}

type Note = DesignComment & { key: string };
type Composer = { key: string; kind: "new" | "edit" | "read"; at: { x: number; y: number } | null };

const unsent = new Map<string, Note[]>();

const pageSubtitle = (page: { tabs?: unknown[] } | null, tab: { title: string } | null) => (page?.tabs && page.tabs.length > 1 && tab ? tab.title : "Artifact");

const refOf = (page: Artifact): ArtifactRef => ({ id: page.id, version: page.version, title: page.title, format: page.format });

/**
 * `onClose` is set where the page is a tab of the right panel docked beside its Chat (an iPad), and closes the tab;
 * `onPage` shows another page of the Artifact in that tab.
 */
export function ArtifactSheet({
  hostId,
  chatId,
  id,
  tab: targetTab,
  comment: commentId,
  requestId,
  onClose,
  onPage,
}: {
  hostId?: string;
  chatId?: string;
  id?: string;
  kind?: string;
  tab?: string;
  comment?: string;
  requestId?: string;
  onClose?: () => void;
  onPage?: (target: DesignsTab) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { client, snapshot, designs: feature } = useSession();
  const insets = useSafeAreaInsets();
  const close = useCallback(() => (onClose ? onClose() : router.back()), [onClose]);
  const source = client && chatId && id && (!hostId || hostId === client.url) ? client : null;
  const [state, setState] = useState<{ artifact: Artifact | null; error: string }>({ artifact: null, error: "" });
  const sharing = useShareAvailable(source, hostId, chatId);
  const library = useDesignLibrary(source, chatId);

  const [revision, setRevision] = useState(0);
  const pageRevision = commentActivity(snapshot, chatId, "artifact");
  useVisibleRunChatKeys(client, chatId ? [chatId] : []);
  useEffect(() => {
    const watch = AppState.addEventListener("change", (status) => {
      if (status === "active") setRevision((value) => value + 1);
    });
    return () => watch.remove();
  }, []);
  const [sent, setSent] = useState<ArtifactComment[]>([]);
  useEffect(() => {
    if (!source || !id) return;
    let live = true;
    source
      .call<Artifact>("artifact:get", [{ chatId, id }])
      .then((artifact) => {
        if (artifact.format !== "html") throw new Error("This page is no longer available.");
        if (live) setState({ artifact, error: "" });
      })
      .catch((error: unknown) => live && setState({ artifact: null, error: error instanceof Error ? error.message : "Could not load this page." }));
    source
      .call<ArtifactComment[]>("artifact:comments", [{ chatId }])
      .then((comments) => live && setSent(Array.isArray(comments) ? comments : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [source, chatId, id, revision, pageRevision, requestId]);
  const artifact = source && state.artifact?.format === "html" ? state.artifact : null;
  const [tabId, setTabId] = useState<string | null>(() => targetTab ?? rememberedTab(hostId, chatId, id) ?? null);
  const tab = artifact ? artifactTab(artifact, tabId) : null;
  const files = usePageFiles(source, chatId, artifact?.assets);
  const designs = useChatDesigns(source, chatId, `${revision}:${pageRevision}`, feature.enabled === true);
  const pageId = artifact?.id;
  const shownTab = tab?.id;
  useEffect(() => {
    if (hostId && chatId && pageId && shownTab !== undefined) rememberPage(hostId, chatId, pageId, shownTab);
  }, [hostId, chatId, pageId, shownTab]);

  const feedbackKey = hostId && chatId ? `${hostId}|${chatId}|artifacts` : null;
  const [notes, setNotes] = useState<Note[]>(() => (feedbackKey && unsent.get(feedbackKey)) || []);
  useEffect(() => {
    if (!feedbackKey) return;
    const written = notes.filter((note) => note.text.trim());
    if (written.length) unsent.set(feedbackKey, written);
    else unsent.delete(feedbackKey);
  }, [feedbackKey, notes]);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const request = JSON.stringify([targetTab, commentId, requestId]);
  const [previousRequest, setPreviousRequest] = useState(request);
  if (previousRequest !== request) {
    setPreviousRequest(request);
    setTabId(targetTab ?? null);
    setComposer(null);
  }
  const pendingComment = useRef<string | null>(null);
  useEffect(() => {
    pendingComment.current = commentId ?? null;
  }, [targetTab, commentId, requestId]);

  const page = useRef<DomWebViewRef>(null);
  const ready = useRef(false);
  const [epoch, setEpoch] = useState(0);
  const [commenting, setCommenting] = useState(false);
  // A different tab mounts a new WebView. Wait for its helper before sending pins or a reveal.
  useEffect(() => {
    ready.current = false;
  }, [artifact?.id, artifact?.version, tab?.id]);
  const command = useCallback((message: Record<string, unknown> & { t: string }) => {
    if (!ready.current || !page.current) return;
    page.current.injectJavaScript(`window.milagreArtifact&&window.milagreArtifact.run(${JSON.stringify(message)});true;`);
  }, []);
  useEffect(() => {
    command({ t: "mode", input: "touch", comment: commenting });
  }, [command, epoch, commenting]);

  const numbers = useMemo(() => sentNumbers(sent), [sent]);
  const pins = useMemo<PagePin[]>(() => {
    if (!artifact || !tab) return [];
    const done = sent.flatMap((comment) =>
      comment.design.id !== artifact.id ||
      comment.design.version !== artifact.version ||
      comment.x === undefined ||
      comment.y === undefined ||
      (!showResolved && comment.resolved !== undefined && composer?.key !== `sent:${comment.id}`) ||
      !onArtifactTab(comment, artifact, tab)
        ? []
        : [
            {
              k: `sent:${comment.id}`,
              x: comment.x,
              y: comment.y,
              ...(comment.anchor ? { a: comment.anchor } : {}),
              n: numbers.get(comment.id) ?? 1,
              fill: comment.resolved ? colors.greenInk : colors.ink2,
              ink: comment.resolved ? colors.onGreen : colors.page,
              label: `Sent comment${comment.resolved ? ", resolved" : ""}: ${comment.text}`,
            },
          ],
    );
    const waiting = notes.flatMap((note, index) =>
      note.x === undefined || note.y === undefined || !onArtifactTab(note, artifact, tab)
        ? []
        : [
            {
              k: note.key,
              x: note.x,
              y: note.y,
              ...(note.anchor ? { a: note.anchor } : {}),
              n: index + 1,
              fill: colors.accentInk,
              ink: colors.onAccent,
              label: `Comment ${index + 1}`,
            },
          ],
    );
    return [...done, ...waiting].map((pin) => (pin.k === composer?.key ? { ...pin, hide: true } : pin));
  }, [
    artifact,
    tab,
    sent,
    notes,
    numbers,
    composer?.key,
    showResolved,
    colors.greenInk,
    colors.onGreen,
    colors.ink2,
    colors.page,
    colors.accentInk,
    colors.onAccent,
  ]);
  // A pin just opened scrolls near the top once the page has it, out of the keyboard's way; the page then says where it
  const revealing = useRef<string | null>(null);
  const pinsKey = JSON.stringify(pins);
  const watch = composer?.key ?? null;
  useEffect(() => {
    if (!ready.current) return;
    command({ t: "pins", pins: JSON.parse(pinsKey), watch });
    if (revealing.current) {
      command({ t: "reveal", k: revealing.current });
      revealing.current = null;
    }
  }, [pinsKey, watch, command, epoch]);
  // Comments may arrive after the page. A new request also works in an already-mounted iPad dock.
  useEffect(() => {
    if (!ready.current || !artifact || !tab || !pendingComment.current) return;
    const comment = sent.find((item) => item.id === pendingComment.current);
    if (!comment || comment.design.id !== artifact.id || comment.design.version !== artifact.version || !onArtifactTab(comment, artifact, tab)) return;
    pendingComment.current = null;
    if (comment.x === undefined || comment.y === undefined) return;
    const key = `sent:${comment.id}`;
    revealing.current = key;
    setComposer({ key, kind: "read", at: null });
  }, [artifact, tab, sent, epoch, commentId, requestId]);

  const onMessage = useCallback(
    (data: string) => {
      const message = readArtifactEvent(data);
      if (!message) return;
      switch (message.t) {
        case "download": {
          const file = artifactDownload(artifact?.assets, message, (asset) => files.uris?.get(asset.name));
          const uri = file && files.uris?.get(file.asset.name);
          if (file && uri) router.push({ pathname: "/file-preview", params: { uri, name: file.name } });
          return;
        }
        case "ready":
          ready.current = true;
          setEpoch((value) => value + 1);
          return;
        case "press": {
          if (!artifact || !tab || composer) return;
          tap();
          const key = newCommentId();
          setNotes((current) => [
            ...current,
            {
              key,
              design: refOf(artifact),
              x: message.x,
              y: message.y,
              text: "",
              ...(message.a ? { anchor: message.a } : {}),
              ...(message.near ? { near: message.near } : {}),
              ...(artifact.tabs ? { tab: { id: tab.id, title: tab.title } } : {}),
            },
          ]);
          revealing.current = key;
          setComposer({ key, kind: "new", at: null });
          return;
        }
        case "pin": {
          if (composer) return;
          const note = notes.find((item) => item.key === message.k);
          const comment = message.k.startsWith("sent:") ? sent.find((item) => `sent:${item.id}` === message.k) : undefined;
          if (!note && !comment) return;
          revealing.current = message.k;
          setComposer({ key: message.k, kind: note ? "edit" : "read", at: null });
          return;
        }
        case "anchor":
          setComposer((current) => (current && current.key === message.k ? { ...current, at: { x: message.sx, y: message.sy } } : current));
          return;
      }
    },
    [artifact, tab, composer, notes, sent, files.uris],
  );

  const closeComposer = (remove = false) => {
    if (!composer) return;
    const { key } = composer;
    setNotes((current) => current.filter((note) => note.key !== key || (!remove && note.text.trim())));
    setComposer(null);
  };
  const written = notes.filter((note) => note.text.trim());
  const send = () => {
    if (!hostId || !chatId || !written.length || !source) return;
    const comments: DesignComment[] = written.map(({ key: _key, ...note }) => ({ ...note, text: note.text.trim(), id: newCommentId() }));
    if (feedbackKey) unsent.delete(feedbackKey);
    postDesignMessage(`${hostId}|${chatId}`, {
      kind: "artifacts",
      text: designFeedbackMessage({ comments }),
      onSent: () => {
        source
          .call("artifact:add-comments", [{ chatId, comments }])
          .then(() => source.call<ArtifactComment[]>("artifact:comments", [{ chatId }]))
          .then((all) => Array.isArray(all) && setSent(all))
          .catch(() => {});
      },
    });
    if (!onClose) {
      close();
      return;
    }
    sendDesignMessageNow(`${hostId}|${chatId}`);
    setComposer(null);
    setCommenting(false);
    setNotes([]);
  };
  const pages = artifactPageMenu({
    hostId,
    chatId,
    designs,
    page: artifact && { id: artifact.id, title: artifact.title, tabs: (artifact.tabs ?? []).map((item) => ({ id: item.id, title: item.title })) },
    library,
    current: { kind: "page", tab: tab?.id ?? "" },
    onPage,
    onTab: (next) => {
      closeComposer();
      setTabId(next);
    },
  });

  const openNote = composer && composer.kind !== "read" ? notes.find((note) => note.key === composer.key) : undefined;
  const openSent = composer?.kind === "read" ? sent.find((comment) => `sent:${comment.id}` === composer.key) : undefined;
  const [room, setRoom] = useState({ width: 0, height: 0 });
  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, height: 52, gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 8, width: 76 }}>
          {/* In the panel docked beside the Chat (an iPad), the panel's own button closes it. */}
          {!onClose && <CircleButton label="Close artifact" icon={Cancel01Icon} onPress={close} />}
        </View>
        <ArtifactPageTitle title={artifact?.title ?? "Artifact"} subtitle={pageSubtitle(artifact, tab)} sections={pages.sections} onSelect={pages.choose} />
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          {source && (
            <CircleButton
              label={commenting ? "Stop commenting" : "Comment on the page"}
              icon={CommentAdd01Icon}
              selected={commenting}
              onPress={() => {
                closeComposer();
                setCommenting((value) => !value);
              }}
            />
          )}
          {source && written.length > 0 && (
            <CircleButton label={`Send ${written.length} to the agent`} icon={Sent02Icon} filled badge={written.length} onPress={send} />
          )}
          {artifactPageActions({
            source,
            hostId,
            chatId,
            page: artifact,
            tab: tab?.id,
            sharing,
            library,
            showResolved,
            onShowResolved: setShowResolved,
            onPage,
          })}
        </View>
      </View>
      <View style={{ flex: 1, backgroundColor: colors.paper }} onLayout={(event) => setRoom(event.nativeEvent.layout)}>
        {!source ? (
          <Text style={[styles.muted, { padding: space.xl }]}>Reconnect to your computer to open this page.</Text>
        ) : state.error ? (
          <View style={{ padding: space.xl }}>
            <ErrorNotice message={state.error} retry={() => setRevision((value) => value + 1)} retryTitle="Retry" />
          </View>
        ) : artifact && tab && files.error ? (
          <View style={{ padding: 20, gap: 16 }}>
            <Text accessibilityRole="alert" style={{ color: colors.redInk }}>
              {files.error}
            </Text>
            <PillButton title="Retry" onPress={() => setRevision((value) => value + 1)} />
          </View>
        ) : artifact && tab && files.uris ? (
          <ArtifactWebView
            key={`${artifact.id}:${artifact.version}:${tab.id}`}
            ref={page}
            html={artifact.assets ? pageWithFiles(tab.html, artifact.assets, files.uris) : tab.html}
            files={!!artifact.assets}
            onMessage={onMessage}
          />
        ) : artifact && tab ? (
          <Text accessibilityRole="progressbar" style={[styles.muted, { padding: 20 }]}>
            {`Loading the page's files… ${files.total ? Math.floor((files.received / files.total) * 100) : 0}%`}
          </Text>
        ) : (
          <Text style={[styles.muted, { padding: space.xl }]}>Loading page…</Text>
        )}
        {composer && (
          <>
            <Pressable accessibilityRole="button" accessibilityLabel="Close the comment" style={StyleSheet.absoluteFill} onPress={() => closeComposer()} />
            {composer.at && (openNote || openSent) && (
              <CommentBox
                at={composer.at}
                kind={composer.kind}
                note={openNote}
                sentComment={openSent}
                number={openNote ? notes.indexOf(openNote) + 1 : openSent ? (numbers.get(openSent.id) ?? 1) : 1}
                onChange={(text) => setNotes((current) => current.map((note) => (note.key === composer.key ? { ...note, text } : note)))}
                onCancel={() => closeComposer(true)}
                onDone={() => closeComposer()}
                onSend={send}
                room={room}
              />
            )}
          </>
        )}
      </View>
    </View>
  );
}

/**
 * The page inside artifactShell, from a cache file of its own. The page's own scripts run in its sandboxed frame with
 * an opaque origin, so they can't read the phone's files (this web view grants a file: page read access to all of
 * them), make requests, or navigate the page or its own frame away. The shell's one script passes the page helper's
 * messages through, which `onMessage` reads by their shape; the Expo modules bridge stays off. Mermaid blocks draw
 * with Pele, which the shell's page carries.
 */
function ArtifactWebView({
  ref,
  html,
  files = false,
  onMessage,
}: {
  ref?: React.Ref<DomWebViewRef>;
  html: string;
  files?: boolean;
  onMessage?: (data: string) => void;
}) {
  const { colors } = useTheme();
  const [crashed, setCrashed] = useState(false);
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const prepared = useMemo(() => {
    const page = artifactShell(html, { diagrams: PELE_SCRIPT, ...(files ? { assets: "file:" } : {}) });
    let hash = 5381;
    for (let index = 0; index < html.length; index++) hash = (hash * 33) ^ html.charCodeAt(index);
    const file = new File(Paths.cache, `artifact-${id}-${(hash >>> 0).toString(36)}.html`);
    try {
      file.writeSync(page);
      return { file, uri: file.uri };
    } catch {
      return null;
    }
  }, [html, id, files]);
  useEffect(
    () => () => {
      try {
        if (prepared?.file.exists) prepared.file.delete();
      } catch {}
    },
    [prepared],
  );
  const uri = prepared?.uri;
  if (crashed || !prepared)
    return (
      <View style={{ padding: space.xl }}>
        <ErrorNotice message="Could not prepare this page." />
      </View>
    );
  if (!uri) return null;
  return (
    <DomWebView
      ref={ref}
      source={{ uri }}
      style={{ flex: 1, backgroundColor: colors.paper }}
      containerStyle={{ flex: 1 }}
      useExpoModulesBridge={false}
      allowsInlineMediaPlayback
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      onMessage={onMessage ? (event) => onMessage(event.nativeEvent.data) : undefined}
      onContentProcessDidTerminate={() => setCrashed(true)}
      onRenderProcessGone={() => setCrashed(true)}
    />
  );
}
