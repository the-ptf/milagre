import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import { ArrowRight01Icon, Cancel01Icon, CheckmarkCircle02Icon, File01Icon, MoreHorizontalIcon, PaintBoardIcon } from "@hugeicons/core-free-icons";
import {
  artifactShell,
  designFeedbackMessage,
  designFeedbackText,
  newCommentId,
  readPageMessage,
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
import { PillButton, PullDown, tap, useStyles, type MenuSection } from "./ui";
import { useTheme } from "./theme";
import { PELE_SCRIPT } from "./pele-script";
import { onShareAvailability } from "./share-availability";
import { CommentBox, RoundButton, SendButton } from "./viewer-chrome";

/** Feedback the user sent on the designs, as what it was: the design they chose, then each comment and its design. */
export function DesignFeedbackCard({
  feedback,
  chatId,
  moved = 0,
}: {
  feedback: { choice: ArtifactRef | null; comments: DesignComment[] };
  chatId?: string;
  /** Changes as the Chat moves on, to read the agent's resolutions again. */
  moved?: number;
}) {
  const { colors } = useTheme();
  const { client, designs: feature } = useSession();
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
  // The agent's notes on the comments it resolved, by comment id.
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
      <Text selectable style={{ color: colors.ink, fontSize: 15, lineHeight: 21 }}>
        {designFeedbackText(feedback)}
      </Text>
    );
  return (
    <View style={{ gap: 8 }}>
      <View
        accessibilityLabel={feedbackLabel}
        style={{
          minWidth: 240,
          borderRadius: 18,
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
            gap: 6,
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderColor: colors.line,
          }}
        >
          <Icon icon={PaintBoardIcon} tone="ink2" size={14} />
          <Text style={{ color: colors.ink2, fontSize: 12 }}>{feedbackLabel}</Text>
        </View>
        {choice && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <Icon icon={CheckmarkCircle02Icon} tone="accent" size={16} />
            <Text style={{ flex: 1, color: colors.ink, fontSize: 15 }} numberOfLines={1}>
              Chose {choice.title}
            </Text>
            <Text style={{ color: colors.ink3, fontSize: 12 }}>{format(choice) === "design" ? `v${choice.version}` : "Artifact"}</Text>
          </View>
        )}
        {comments.map((comment, index) => {
          const resolved = comment.id ? resolutions.get(comment.id) : undefined;
          return (
            <View
              key={index}
              style={{
                flexDirection: "row",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderTopWidth: 1,
                borderColor: colors.line,
              }}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  // The desktop canvas's pin: round, its point the top-left corner.
                  borderRadius: 10,
                  borderTopLeftRadius: 0,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: resolved === undefined ? colors.accent : colors.green,
                }}
              >
                <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "600" }}>{index + 1}</Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  selectable
                  style={{
                    color: resolved === undefined ? colors.ink : colors.ink3,
                    fontSize: 15,
                    lineHeight: 21,
                    textDecorationLine: resolved === undefined ? "none" : "line-through",
                  }}
                >
                  {comment.text}
                </Text>
                {resolved !== undefined && (
                  <View
                    accessibilityLabel={`Resolved: ${resolved}`}
                    style={{
                      flexDirection: "row",
                      gap: 4,
                      alignItems: "flex-start",
                    }}
                  >
                    <Icon icon={CheckmarkCircle02Icon} tone="green" size={14} />
                    <Text selectable style={{ flex: 1, color: colors.green, fontSize: 13 }}>
                      {resolved}
                    </Text>
                  </View>
                )}
                <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 12 }}>
                  {comment.design.title}
                  {format(comment.design) === "design" ? ` · v${comment.design.version}` : " · Artifact"}
                </Text>
              </View>
            </View>
          );
        })}
      </View>
      {plain ? (
        <Text selectable style={{ color: colors.ink, fontSize: 15, lineHeight: 21 }}>
          {plain}
        </Text>
      ) : null}
    </View>
  );
}

/** The designs one reply showed: a card for one, one card naming them all for several, which opens at the first. */
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
  const html = steps.findLast((step) => format(step.artifact) === "html");
  const designs = steps.filter((step) => format(step.artifact) === "design");
  if (html)
    return (
      <View style={{ gap: 8 }}>
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
        gap: 10,
        padding: 12,
        borderRadius: 14,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: pressed ? colors.hover : colors.surface,
        opacity: openable ? 1 : 0.6,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.canvas,
        }}
      >
        <Icon icon={PaintBoardIcon} tone="ink2" size={18} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.ink, fontSize: 15, fontWeight: "500" }}>{steps.length} designs</Text>
        <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 12 }}>
          {titles}
        </Text>
      </View>
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </Pressable>
  );
}

/** Opens a Chat's designs (or its HTML artifact) in the right panel docked beside it on an iPad, full screen on a phone. */
function openDesigns(openTab: ReturnType<typeof usePanelTabs>, target: DesignsTab) {
  if (openTab) {
    openTab({ kind: "designs", target });
    return;
  }
  const { html, ...params } = target;
  router.push({ pathname: "/artifact-sheet", params: { ...params, ...(html ? { kind: "html" } : {}) } });
}

/** A design the agent showed. It opens the Chat's designs full screen; a saved Chat is needed to read them. */
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
        gap: 10,
        padding: 12,
        borderRadius: 14,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: isChosen ? colors.accent : colors.line,
        backgroundColor: pressed ? colors.hover : colors.surface,
        opacity: openable ? 1 : 0.6,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.canvas,
        }}
      >
        <Icon icon={kind === "html" ? File01Icon : PaintBoardIcon} tone="ink2" size={18} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 15, fontWeight: "500" }}>
          {title}
        </Text>
        <Text style={{ color: colors.ink3, fontSize: 12 }}>
          {kind === "html" ? "Artifact" : `Design · version ${version}`}
          {isChosen ? " · chosen" : ""}
        </Text>
      </View>
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </Pressable>
  );
}

/** A comment waiting for Send, pinned where the user held the page. */
type Note = DesignComment & { key: string };
/** The comment box open on a pin: a new one being written, a waiting one to change, or a sent one to read. */
type Composer = { key: string; kind: "new" | "edit" | "read"; at: { x: number; y: number } | null };

/**
 * Feedback not sent yet, by Chat: leaving the page keeps the comments until they are sent or deleted, as on desktop.
 * In memory, for the app's life.
 */
const unsent = new Map<string, Note[]>();

const refOf = (page: Artifact): ArtifactRef => ({ id: page.id, version: page.version, title: page.title, format: page.format });

/**
 * The Chat's HTML artifact full screen, as the Designs open (their canvas is DesignsSheet): a header like the in-app
 * browser's, close on the left, Send and ⋯ on the right, and the page under it filling the screen at the phone's
 * width, pinching and scrolling as a web page does. Holding a spot on the page pins a comment there, written in a box
 * that opens from the pin; comments wait for Send, which hands them to the Chat as one message for the agent.
 */
/** `onClose` is set where the page is a tab of the right panel docked beside its Chat (an iPad), and closes the tab. */
export function ArtifactSheet({ hostId, chatId, id, onClose }: { hostId?: string; chatId?: string; id?: string; kind?: string; onClose?: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { client, snapshot } = useSession();
  const insets = useSafeAreaInsets();
  const close = useCallback(() => (onClose ? onClose() : router.back()), [onClose]);
  const source = client && chatId && id && (!hostId || hostId === client.url) ? client : null;
  const [state, setState] = useState<{ artifact: Artifact | null; error: string }>({ artifact: null, error: "" });
  // Share shows only once this host says sharing works for this Chat's page; a reply a newer check overtook is ignored.
  const sharingScope = useMemo(() => ({ source, chatId }), [source, chatId]);
  const [sharingAvailable, setSharingAvailable] = useState<typeof sharingScope | null>(null);
  const sharingRequest = useRef(0);
  useEffect(() => {
    if (!source) return;
    let live = true;
    const refresh = () => {
      const current = ++sharingRequest.current;
      setSharingAvailable(null);
      source
        .call<{ available: boolean }>("artifact:sharing-status", [{ kind: "artifacts" }])
        .then((status) => {
          if (live && current === sharingRequest.current && status?.available === true) setSharingAvailable(sharingScope);
        })
        .catch(() => {});
    };
    refresh();
    const watch = AppState.addEventListener("change", (status) => {
      if (status === "active") refresh();
      else {
        sharingRequest.current++;
        setSharingAvailable(null);
      }
    });
    return () => {
      live = false;
      watch.remove();
    };
  }, [source, sharingScope]);
  useEffect(() => {
    if (!hostId || !chatId) return;
    return onShareAvailability(hostId, chatId, "artifacts", (available) => {
      sharingRequest.current++;
      setSharingAvailable(available === true ? sharingScope : null);
    });
  }, [hostId, chatId, sharingScope]);
  const sharing = !!source && sharingAvailable === sharingScope;

  const [revision, setRevision] = useState(0);
  // The agent's finished artifact steps: a new one may be a new version of the page.
  const pageRevision = chatId
    ? snapshot?.runs.runs[chatId]?.steps
        .filter((step) => step.kind === "artifact" && step.status === "done")
        .map((step) => step.id)
        .join("|")
    : undefined;
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
  }, [source, chatId, id, revision, pageRevision]);
  const artifact = source ? state.artifact : null;

  const feedbackKey = hostId && chatId ? `${hostId}|${chatId}|artifacts` : null;
  const [notes, setNotes] = useState<Note[]>(() => (feedbackKey && unsent.get(feedbackKey)) || []);
  useEffect(() => {
    if (!feedbackKey) return;
    const written = notes.filter((note) => note.text.trim());
    if (written.length) unsent.set(feedbackKey, written);
    else unsent.delete(feedbackKey);
  }, [feedbackKey, notes]);
  const [composer, setComposer] = useState<Composer | null>(null);

  // The page: until its helper says it is ready, commands are dropped, and each time it does (the page loaded again)
  // it is told everything again.
  const page = useRef<DomWebViewRef>(null);
  const ready = useRef(false);
  const [epoch, setEpoch] = useState(0);
  const command = useCallback((message: Record<string, unknown> & { t: string }) => {
    if (!ready.current || !page.current) return;
    page.current.injectJavaScript(`window.milagreArtifact&&window.milagreArtifact.run(${JSON.stringify(message)});true;`);
  }, []);
  useEffect(() => {
    command({ t: "mode", input: "touch", comment: false });
  }, [command, epoch]);

  // The pins on the page as it is now: waiting comments numbered in Send order, sent ones within their message.
  const numbers = useMemo(() => sentNumbers(sent), [sent]);
  const pins = useMemo<PagePin[]>(() => {
    if (!artifact) return [];
    const done = sent.flatMap((comment) =>
      comment.design.id !== artifact.id || comment.design.version !== artifact.version || comment.x === undefined || comment.y === undefined
        ? []
        : [
            {
              k: `sent:${comment.id}`,
              x: comment.x,
              y: comment.y,
              ...(comment.anchor ? { a: comment.anchor } : {}),
              n: numbers.get(comment.id) ?? 1,
              fill: comment.resolved ? colors.green : colors.ink2,
              ink: colors.page,
              label: `Sent comment${comment.resolved ? ", resolved" : ""}: ${comment.text}`,
            },
          ],
    );
    const waiting = notes.flatMap((note, index) =>
      note.x === undefined || note.y === undefined
        ? []
        : [
            {
              k: note.key,
              x: note.x,
              y: note.y,
              ...(note.anchor ? { a: note.anchor } : {}),
              n: index + 1,
              fill: colors.accent,
              ink: colors.onAccent,
              label: `Comment ${index + 1}`,
            },
          ],
    );
    return [...done, ...waiting].map((pin) => (pin.k === composer?.key ? { ...pin, hide: true } : pin));
  }, [artifact, sent, notes, numbers, composer?.key, colors.green, colors.ink2, colors.page, colors.accent, colors.onAccent]);
  // A pin just opened scrolls near the top once the page has it, out of the keyboard's way; the page then says where it
  // landed, and the box opens there.
  const revealing = useRef<string | null>(null);
  const pinsKey = JSON.stringify(pins);
  const watch = composer?.key ?? null;
  useEffect(() => {
    command({ t: "pins", pins: JSON.parse(pinsKey), watch });
    if (revealing.current) {
      command({ t: "reveal", k: revealing.current });
      revealing.current = null;
    }
  }, [pinsKey, watch, command, epoch]);

  const onMessage = useCallback(
    (data: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const message = readPageMessage(parsed);
      if (!message) return;
      switch (message.t) {
        case "ready":
          ready.current = true;
          setEpoch((value) => value + 1);
          return;
        case "press": {
          if (!artifact || composer) return;
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
    [artifact, composer, notes, sent],
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
    // Each comment gets the id the agent resolves it by; the host records the comments once the message went.
    const comments: DesignComment[] = written.map(({ key: _key, ...note }) => ({ ...note, text: note.text.trim(), id: newCommentId() }));
    if (feedbackKey) unsent.delete(feedbackKey);
    postDesignMessage(`${hostId}|${chatId}`, {
      kind: "artifacts",
      text: designFeedbackMessage({ comments }),
      onSent: () => {
        source.call("artifact:add-comments", [{ chatId, comments }]).catch(() => {});
      },
    });
    // Docked beside the Chat, the Chat is on screen already and sends it now.
    if (onClose) sendDesignMessageNow(`${hostId}|${chatId}`);
    close();
  };
  const openShare = () => {
    if (hostId && chatId) router.push({ pathname: "/design-share-sheet", params: { hostId, chatId, kind: "artifacts" } });
  };
  const menu: MenuSection[] = sharing ? [{ items: [{ id: "share", title: "Share page", systemImage: "square.and.arrow.up" }] }] : [];

  const openNote = composer && composer.kind !== "read" ? notes.find((note) => note.key === composer.key) : undefined;
  const openSent = composer?.kind === "read" ? sent.find((comment) => `sent:${comment.id}` === composer.key) : undefined;
  const [room, setRoom] = useState({ width: 0, height: 0 });
  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, height: 52, gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 8, width: 76 }}>
          {/* In the panel docked beside the Chat (an iPad), the panel's own button closes it. */}
          {!onClose && <RoundButton label="Close artifact" icon={Cancel01Icon} onPress={close} />}
        </View>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.ink, fontSize: 14, fontWeight: "600" }}>
            {artifact?.title ?? "Artifact"}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 12 }}>
            Artifact
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8, width: 76, justifyContent: "flex-end" }}>
          {source && written.length > 0 && <SendButton count={written.length} onPress={send} />}
          {menu.length > 0 && (
            <PullDown label="Page actions" sections={menu} onSelect={(action) => action === "share" && openShare()}>
              <RoundButton label="Page actions" icon={MoreHorizontalIcon} />
            </PullDown>
          )}
        </View>
      </View>
      <View style={{ flex: 1, backgroundColor: "#ffffff" }} onLayout={(event) => setRoom(event.nativeEvent.layout)}>
        {!source ? (
          <Text style={[styles.muted, { padding: 20 }]}>Reconnect to this Mac to open this page.</Text>
        ) : state.error ? (
          <View style={{ padding: 20, gap: 16 }}>
            <Text accessibilityRole="alert" style={{ color: colors.red }}>
              {state.error}
            </Text>
            <PillButton title="Retry" onPress={() => setRevision((value) => value + 1)} />
          </View>
        ) : artifact ? (
          <ArtifactWebView key={`${artifact.id}:${artifact.version}`} ref={page} html={artifact.html} onMessage={onMessage} />
        ) : (
          <Text style={[styles.muted, { padding: 20 }]}>Loading page...</Text>
        )}
        {composer && (
          <>
            <Pressable accessibilityLabel="Close the comment" style={StyleSheet.absoluteFill} onPress={() => closeComposer()} />
            {composer.at && (openNote || openSent) && (
              <CommentBox
                // Inside the screen, and high enough to stay clear of the keyboard: a pin the page can't scroll up that far
                // opens its box above where it sits.
                at={{
                  x: Math.max(12, Math.min(composer.at.x, room.width - BOX_WIDTH - 12)),
                  y: Math.max(8, Math.min(composer.at.y, Math.max(8, room.height * 0.42 - 40))),
                }}
                kind={composer.kind}
                note={openNote}
                sentComment={openSent}
                number={openNote ? notes.indexOf(openNote) + 1 : openSent ? (numbers.get(openSent.id) ?? 1) : 1}
                onChange={(text) => setNotes((current) => current.map((note) => (note.key === composer.key ? { ...note, text } : note)))}
                onCancel={() => closeComposer(true)}
                onDone={() => closeComposer()}
              />
            )}
          </>
        )}
      </View>
    </View>
  );
}
// CommentBox's width (viewer-chrome.tsx).
const BOX_WIDTH = 272;

/**
 * The page inside artifactShell, from a cache file of its own. The page's own scripts run in its sandboxed frame with
 * an opaque origin, so they can't read the phone's files (this web view grants a file: page read access to all of
 * them), make requests, or navigate the page or its own frame away. The shell's one script passes the page helper's
 * messages through, which `onMessage` reads by their shape; the Expo modules bridge stays off. Mermaid blocks draw
 * with Pele, which the shell's page carries.
 */
function ArtifactWebView({ ref, html, onMessage }: { ref?: React.Ref<DomWebViewRef>; html: string; onMessage?: (data: string) => void }) {
  const { colors } = useTheme();
  const [crashed, setCrashed] = useState(false);
  // Written while rendering, so the page is there on the first frame; each page gets a file of its own, removed when
  // the page changes or goes. Named for this view and the page's content: two views never share a file.
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const prepared = useMemo(() => {
    const page = artifactShell(html, { diagrams: PELE_SCRIPT });
    let hash = 5381;
    for (let index = 0; index < html.length; index++) hash = (hash * 33) ^ html.charCodeAt(index);
    const file = new File(Paths.cache, `artifact-${id}-${(hash >>> 0).toString(36)}.html`);
    try {
      file.writeSync(page);
      return { file, uri: file.uri };
    } catch {
      return null;
    }
  }, [html, id]);
  useEffect(
    () => () => {
      try {
        if (prepared?.file.exists) prepared.file.delete();
      } catch {
        /* The OS may purge cache files while backgrounding. */
      }
    },
    [prepared],
  );
  const uri = prepared?.uri;
  if (crashed || !prepared)
    return (
      <Text accessibilityRole="alert" style={{ color: colors.red, padding: 20 }}>
        Could not prepare this page.
      </Text>
    );
  if (!uri) return null;
  return (
    <DomWebView
      ref={ref}
      source={{ uri }}
      style={{ flex: 1, backgroundColor: "#ffffff" }}
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
