import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  FadeOut,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import { File, Paths } from "expo-file-system";
import { Cancel01Icon, DashboardSquare01Icon, MoreHorizontalIcon, Share08Icon } from "@hugeicons/core-free-icons";
import {
  artifactDocument,
  designFeedbackMessage,
  designGroups,
  designsCanvasShell,
  newCommentId,
  sentNumbers,
  type Artifact,
  type ArtifactComment,
  type ArtifactSummary,
  type DesignComment,
} from "@milagre/shared/artifact";
import type { ArtifactRef } from "@milagre/shared/model";
import { postDesignMessage, sendDesignMessageNow } from "./design-outbox";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { PillButton, PullDown, tap, useStyles, type MenuSection } from "./ui";
import { markDesignDeleted } from "./use-design-catalog";
import { onShareAvailability } from "./share-availability";
import { loadCanvasDesign } from "./design-font-cache";
import { CommentBox, RoundButton, SendButton } from "./viewer-chrome";

/** A comment waiting for Send, pinned where the user held the design. */
type Note = DesignComment & { key: string };
/** What the canvas shows: one design fitted, or the whole board. */
type CanvasView = { mode: "design" | "canvas"; id: string | null };
/** The comment box open on a pin: a new one being written, a waiting one to change, or a sent one to read. */
type Composer = { key: string; kind: "new" | "edit" | "read"; at: { x: number; y: number } | null };
type CanvasCommand = Record<string, unknown> & { t: string };

/**
 * Feedback not sent yet, by Chat: leaving the designs keeps the pinned comments and the choice until they are sent or
 * deleted, as on desktop. In memory, for the app's life.
 */
const unsent = new Map<string, { notes: Note[]; choice: ArtifactRef | null }>();
const EMPTY_DESIGNS: Record<string, Artifact> = {};

const refOf = (design: Artifact): ArtifactRef => ({ id: design.id, version: design.version, title: design.title, format: design.format });

/**
 * The Chat's designs full screen, on one canvas. The design the card opened fills the screen; pinching out (or the
 * squares button) flies out to every design, a row per group, and a tap flies back in. Holding a design pins a comment
 * there. Comments and the choice wait for Send, in the header with their count, which hands them to the Chat as one
 * message for the agent.
 */
/** `onClose` is set where the canvas is a tab of the right panel docked beside its Chat (an iPad), and closes the tab. */
export function DesignsSheet({
  hostId,
  chatId,
  id,
  version,
  chosen,
  onClose,
}: {
  hostId?: string;
  chatId?: string;
  id?: string;
  version?: string;
  chosen?: string;
  onClose?: () => void;
}) {
  const { colors, motionScale } = useTheme();
  const styles = useStyles();
  const { client, designs: feature, snapshot, reconnects } = useSession();
  const insets = useSafeAreaInsets();
  const close = useCallback(() => (onClose ? onClose() : router.back()), [onClose]);
  const matching = client && chatId && id && (!hostId || hostId === client.url) ? client : null;
  const source = feature.enabled === true ? matching : null;
  const chatKey = hostId && chatId ? `${hostId}|${chatId}|designs` : null;

  const [summaries, setSummaries] = useState<ArtifactSummary[] | null>(null);
  const [listError, setListError] = useState("");
  // The version shown of each design; null shows the newest.
  const [versions, setVersions] = useState<Record<string, number | null>>(() => (id ? { [id]: version ? Number(version) : null } : {}));
  const [loadedState, setLoaded] = useState<{ source: typeof source; chatId: typeof chatId; designs: Record<string, Artifact> }>({
    source,
    chatId,
    designs: {},
  });
  const loaded = loadedState.source === source && loadedState.chatId === chatId ? loadedState.designs : EMPTY_DESIGNS;
  const [view, setView] = useState<CanvasView>({ mode: "design", id: id ?? null });
  const [notes, setNotes] = useState<Note[]>(() => (chatKey && unsent.get(chatKey)?.notes) || []);
  const [choice, setChoice] = useState<ArtifactRef | null>(() => (chatKey && unsent.get(chatKey)?.choice) || null);
  const [sent, setSent] = useState<ArtifactComment[]>([]);
  const [composer, setComposer] = useState<Composer | null>(null);
  // Until the canvas paints its first design, the design icon draws itself over the empty page.
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    if (!chatKey) return;
    const written = notes.filter((note) => note.text.trim());
    if (written.length || choice) unsent.set(chatKey, { notes: written, choice });
    else unsent.delete(chatKey);
  }, [chatKey, notes, choice]);
  useEffect(() => {
    if (feature.enabled === false) close();
  }, [feature.enabled, close]);

  // The agent's finished design steps: a new one means a new design or version to read.
  const revision = chatId
    ? snapshot?.runs.runs[chatId]?.steps
        .filter((step) => step.kind === "artifact" && step.status === "done")
        .map((step) => step.id)
        .join("|")
    : undefined;
  useEffect(() => {
    if (!source) return;
    let live = true;
    source
      .call<ArtifactSummary[]>("artifact:list", [{ chatId }])
      .then((list) => {
        if (!live) return;
        setListError("");
        setSummaries(list.filter((design) => design.format === "design"));
      })
      .catch((error: unknown) => live && setListError(error instanceof Error ? error.message : "Could not load the designs."));
    source
      .call<ArtifactComment[]>("artifact:comments", [{ chatId }])
      .then((comments) => live && setSent(Array.isArray(comments) ? comments : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [source, chatId, revision]);
  // Share shows only once this host says sharing works for this Chat; a reply for another host or Chat, or one a newer
  // check has overtaken, is ignored.
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
        .call<{ available: boolean }>("artifact:sharing-status", [])
        .then((status) => {
          if (live && current === sharingRequest.current && status?.available === true) setSharingAvailable(sharingScope);
        })
        .catch(() => {});
    };
    refresh();
    const watch = AppState.addEventListener("change", (appState) => {
      if (appState === "active") refresh();
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
  const sharing = !!source && sharingAvailable === sharingScope;
  useEffect(() => {
    if (!hostId || !chatId) return;
    return onShareAvailability(hostId, chatId, "designs", (available) => {
      sharingRequest.current++;
      setSharingAvailable(available === true ? sharingScope : null);
    });
  }, [hostId, chatId, sharingScope]);
  // Share opens as a bottom sheet over the designs.
  const openShare = () => {
    if (hostId && chatId) router.push({ pathname: "/design-share-sheet", params: { hostId, chatId } });
  };

  const rows = useMemo(() => designGroups(summaries ?? []), [summaries]);
  const ordered = useMemo(() => rows.flatMap((row) => row.designs), [rows]);

  // Every design's shown version, the opened one first. A newest version reloads when the agent makes
  // another; a chosen older one stays.
  const pendingLoads = useRef(new WeakMap<NonNullable<typeof source>, Map<string, Promise<Artifact>>>());
  useEffect(() => {
    if (!source || !summaries || !chatId) return;
    let live = true;
    let pending = pendingLoads.current.get(source);
    if (!pending) {
      pending = new Map();
      pendingLoads.current.set(source, pending);
    }
    const inFlight = pending;
    const wanted = ordered
      .map((design) => {
        const pinned = versions[design.id] ?? null;
        const have = loaded[design.id];
        const target = pinned ?? design.version;
        return { design, target, stale: !have || have.version !== target };
      })
      .filter((item) => item.stale)
      .sort((a, b) => Number(b.design.id === view.id) - Number(a.design.id === view.id));
    const load = async (queue: typeof wanted) => {
      for (const { design, target } of queue) {
        if (!live) return;
        const key = JSON.stringify([chatId, design.id, target]);
        let promise = inFlight.get(key);
        if (!promise) {
          promise = loadCanvasDesign(source, { chatId, id: design.id, version: target }, reconnects);
          inFlight.set(key, promise);
        }
        try {
          const artifact = await promise;
          if (live && artifact.format === "design" && artifact.document)
            setLoaded((current) => ({
              source,
              chatId,
              designs: { ...(current.source === source && current.chatId === chatId ? current.designs : {}), [design.id]: artifact },
            }));
        } catch {
          /* A deleted or unreadable design stays blank on the board. */
        } finally {
          if (inFlight.get(key) === promise) inFlight.delete(key);
        }
      }
    };
    // Warm the cache with the opened design, then keep relay round trips in parallel.
    // Superseding effects reuse matching in-flight reads, and obsolete queues stop before starting another.
    void load(wanted.slice(0, 1)).then(() => {
      if (!live) return;
      const rest = wanted.slice(1);
      for (let lane = 0; lane < 3; lane++) void load(rest.filter((_, index) => index % 3 === lane));
    });
    return () => {
      live = false;
    };
    // `loaded` is read to skip designs already there; the loads themselves update it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, chatId, summaries, ordered, versions, reconnects]);

  // The canvas page: commands wait for it to say it is ready.
  // The canvas page: until it says it is ready, commands are dropped, and each time it does (a fresh page after the
  // web view reloads too) it is sent everything again.
  const canvas = useRef<DomWebViewRef>(null);
  const ready = useRef(false);
  const [epoch, setEpoch] = useState(0);
  const command = useCallback((message: CanvasCommand) => {
    if (!ready.current || !canvas.current) return;
    canvas.current.injectJavaScript(`window.milagreCanvas&&window.milagreCanvas.run(${JSON.stringify(message)});true;`);
  }, []);

  const layout = useMemo(
    () =>
      rows.map((row) => ({
        group: row.group ?? "",
        designs: row.designs.map((design) => ({ id: design.id, w: design.width, h: design.height })),
      })),
    [rows],
  );
  const layoutKey = JSON.stringify(layout);
  useEffect(() => {
    if (!summaries?.length) return;
    command({ t: "set", rows: layout, focus: id, pad: { top: 0, bottom: insets.bottom }, ink: colors.ink3, accent: colors.accent });
    // The layout's content, not its identity, decides whether the page needs it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, insets.bottom, colors.ink3, colors.accent, command, epoch]);

  const sentDocs = useRef(new Map<string, string>());
  const sentFonts = useRef(new Set<string>());
  useEffect(() => {
    sentDocs.current.clear();
    sentFonts.current.clear();
  }, [source, chatId]);
  useEffect(() => {
    if (!ready.current) return;
    const sendFont = (key: string, css: string) => {
      if (sentFonts.current.has(key)) return;
      command({ t: "fonts", key, css });
      sentFonts.current.add(key);
    };
    for (const artifact of Object.values(loaded)) {
      if (artifact.format === "design" && artifact.fontKey && artifact.fontCss) sendFont(artifact.fontKey, artifact.fontCss);
      const font = artifact.format === "design" ? artifact.fontKey : undefined;
      const key = `${artifact.version}:${artifact.html.length}:${font ?? ""}`;
      if (sentDocs.current.get(artifact.id) === key) continue;
      sentDocs.current.set(artifact.id, key);
      command({ t: "html", id: artifact.id, doc: artifactDocument(artifact.html), ...(font ? { font } : {}) });
    }
    // The layout first: the page makes a design's frame when it lays the design out.
  }, [loaded, command, epoch, layoutKey]);

  // The pins on each design's shown version: waiting comments numbered in Send order, sent ones within their message.
  const numbers = useMemo(() => sentNumbers(sent), [sent]);
  const pins = useMemo(() => {
    const shown = (designId: string) => loaded[designId]?.version;
    const waiting = notes.flatMap((note, index) =>
      note.x === undefined || note.y === undefined || shown(note.design.id) !== note.design.version
        ? []
        : [{ k: note.key, id: note.design.id, x: note.x, y: note.y, n: index + 1, fill: colors.accent, ink: colors.onAccent, label: `Comment ${index + 1}` }],
    );
    const done = sent.flatMap((comment) =>
      comment.x === undefined || comment.y === undefined || shown(comment.design.id) !== comment.design.version
        ? []
        : [
            {
              k: `sent:${comment.id}`,
              id: comment.design.id,
              x: comment.x,
              y: comment.y,
              n: numbers.get(comment.id) ?? 1,
              fill: comment.resolved ? colors.green : colors.ink2,
              ink: colors.page,
              label: `Sent comment${comment.resolved ? ", resolved" : ""}: ${comment.text}`,
            },
          ],
    );
    return [...done, ...waiting].map((pin) => (pin.k === composer?.key ? { ...pin, hide: true } : pin));
  }, [notes, sent, numbers, loaded, composer?.key, colors.accent, colors.onAccent, colors.green, colors.ink2, colors.page]);
  const pinsKey = JSON.stringify(pins);
  useEffect(() => {
    command({ t: "pins", pins: JSON.parse(pinsKey) });
  }, [pinsKey, command, epoch, layoutKey]);

  const onMessage = useCallback(
    (data: string) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
      switch (message.t) {
        case "ready":
          ready.current = true;
          sentDocs.current.clear();
          sentFonts.current.clear();
          setEpoch((value) => value + 1);
          return;
        case "painted":
          setPainted(true);
          return;
        case "view":
          if ((message.mode === "design" || message.mode === "canvas") && typeof message.id === "string") setView({ mode: message.mode, id: message.id });
          return;
        case "press": {
          const x = number(message.x);
          const y = number(message.y);
          const artifact = typeof message.id === "string" ? loaded[message.id] : undefined;
          if (!artifact || x === null || y === null || composer) return;
          tap();
          const key = newCommentId();
          setNotes((current) => [...current, { key, design: refOf(artifact), x, y, text: "" }]);
          setComposer({ key, kind: "new", at: null });
          command({ t: "reveal", id: artifact.id, x, y });
          return;
        }
        case "pin": {
          const key = typeof message.k === "string" ? message.k : "";
          const note = notes.find((item) => item.key === key);
          const comment = key.startsWith("sent:") ? sent.find((item) => `sent:${item.id}` === key) : undefined;
          const target = note ?? comment;
          if (!target || target.x === undefined || target.y === undefined || composer) return;
          setComposer({ key, kind: note ? "edit" : "read", at: null });
          command({ t: "reveal", id: target.design.id, x: target.x, y: target.y });
          return;
        }
        case "anchor": {
          const x = number(message.sx);
          const y = number(message.sy);
          if (x !== null && y !== null) setComposer((current) => (current ? { ...current, at: { x, y } } : current));
          return;
        }
      }
    },
    [command, composer, loaded, notes, sent],
  );

  const shownId = view.id ?? id ?? null;
  const shown = shownId ? loaded[shownId] : undefined;
  const summary = ordered.find((design) => design.id === shownId);
  const row = rows.find((item) => item.designs.some((design) => design.id === shownId));
  const written = notes.filter((note) => note.text.trim());
  const pendingHere = !!shown && choice?.id === shown.id && choice.version === shown.version;
  const sentHere = !!shown && !choice && chosen === `${shown.id}:${shown.version}`;
  const feedback = written.length + (choice ? 1 : 0);

  const closeComposer = (remove = false) => {
    if (!composer) return;
    const { key } = composer;
    setNotes((current) => current.filter((note) => note.key !== key || (!remove && note.text.trim())));
    setComposer(null);
  };
  const send = () => {
    if (!hostId || !chatId || !feedback || !source) return;
    // Each comment gets the id the agent resolves it by; the host records the comments once the message went.
    const comments: DesignComment[] = written.map(({ key: _key, ...note }) => ({ ...note, text: note.text.trim(), id: newCommentId() }));
    if (chatKey) unsent.delete(chatKey);
    postDesignMessage(`${hostId}|${chatId}`, {
      kind: "designs",
      text: designFeedbackMessage({ choice, comments }),
      onSent: () => {
        if (comments.length) source.call("artifact:add-comments", [{ chatId, comments }]).catch(() => {});
      },
    });
    // Docked beside the Chat, the Chat is on screen already and sends it now.
    if (onClose) sendDesignMessageNow(`${hostId}|${chatId}`);
    close();
  };
  const remove = (design: Artifact) =>
    Alert.alert(`Delete ${design.title}?`, "Every version of this design and the comments on it are deleted.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          if (!source || !chatId) return;
          source
            .call("artifact:delete", [{ chatId, id: design.id }])
            .then(() => {
              markDesignDeleted(source, chatId, design.id);
              setNotes((current) => current.filter((note) => note.design.id !== design.id));
              setChoice((current) => (current?.id === design.id ? null : current));
              const index = ordered.findIndex((item) => item.id === design.id);
              const next = ordered[index + 1] ?? ordered[index - 1];
              setSummaries((current) => current?.filter((item) => item.id !== design.id) ?? null);
              if (next) command({ t: "focus", id: next.id });
              else close();
            })
            .catch((error: unknown) => Alert.alert("Could not delete the design", error instanceof Error ? error.message : String(error)));
        },
      },
    ]);

  const canvasMode = view.mode === "canvas";
  const latest = shown && "latest" in shown ? shown.latest : (summary?.versions ?? 1);
  const menu: MenuSection[] = shown
    ? [
        { items: [{ id: "choose", title: pendingHere || sentHere ? "Chosen" : "Choose this design", checked: pendingHere || sentHere, disabled: sentHere }] },
        ...(latest > 1
          ? [
              {
                title: "Versions",
                items: Array.from({ length: latest }, (_, index) => latest - index).map((number) => ({
                  id: `version:${number}`,
                  title: `Version ${number}${number === latest ? " (latest)" : ""}`,
                  systemImage: number === shown.version ? "checkmark" : undefined,
                })),
              },
            ]
          : []),
        ...(sharing ? [{ items: [{ id: "share", title: "Share page", systemImage: "square.and.arrow.up" }] }] : []),
        { items: [{ id: "delete", title: "Delete design", systemImage: "trash", destructive: true }] },
      ]
    : [];
  const choose = (action: string) => {
    if (!shown) return;
    if (action === "choose") setChoice(pendingHere ? null : refOf(shown));
    else if (action === "share") openShare();
    else if (action === "delete") remove(shown);
    else if (action.startsWith("version:")) {
      const number = Number(action.slice("version:".length));
      setVersions((current) => ({ ...current, [shown.id]: number >= latest ? null : number }));
    }
  };

  const position = row && summary && row.designs.length > 1 ? `${row.designs.indexOf(summary) + 1} of ${row.designs.length}` : "";
  const title = canvasMode ? "All designs" : (summary?.title ?? shown?.title ?? "Designs");
  const subtitle = canvasMode
    ? `${ordered.length} ${ordered.length === 1 ? "design" : "designs"}${rows.length > 1 ? ` · ${rows.length} screens` : ""}`
    : [row?.group, position, shown ? `v${shown.version}` : ""].filter(Boolean).join(" · ");

  const openNote = composer && composer.kind !== "read" ? notes.find((note) => note.key === composer.key) : undefined;
  const openSent = composer?.kind === "read" ? sent.find((comment) => `sent:${comment.id}` === composer.key) : undefined;

  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, height: 52, gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 8, width: 76 }}>
          {/* In the panel docked beside the Chat (an iPad), the panel's own button closes it. */}
          {!onClose && <RoundButton label="Close designs" icon={Cancel01Icon} onPress={close} />}
          {source && ordered.length > 0 && (
            <RoundButton
              label={canvasMode ? "Open the design" : "All designs"}
              icon={DashboardSquare01Icon}
              on={canvasMode}
              onPress={() => command(canvasMode && shownId ? { t: "focus", id: shownId } : { t: "overview" })}
            />
          )}
        </View>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.ink, fontSize: 14, fontWeight: "600" }}>
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 12 }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", gap: 8, width: 76, justifyContent: "flex-end" }}>
          {source && feedback > 0 && <SendButton count={feedback} onPress={send} />}
          {canvasMode ? (
            sharing && <RoundButton label="Share page" icon={Share08Icon} onPress={openShare} />
          ) : source && shown ? (
            <PullDown label="Design actions" sections={menu} onSelect={choose}>
              <RoundButton label="Design actions" icon={MoreHorizontalIcon} />
            </PullDown>
          ) : null}
        </View>
      </View>
      <View style={{ flex: 1 }}>
        {!matching ? (
          <Text style={[styles.muted, { padding: 20 }]}>Reconnect to this Mac to open this page.</Text>
        ) : feature.enabled !== true ? (
          <View style={{ padding: 20, gap: 16 }}>
            <Text style={styles.muted}>
              {feature.enabled === false
                ? "Designs is off for this Mac. Update Milagre on the Mac to use Designs."
                : feature.error || "Checking whether Designs is available..."}
            </Text>
            {feature.error && <PillButton title="Retry" onPress={() => void feature.refresh()} />}
          </View>
        ) : listError && !summaries ? (
          <Text accessibilityRole="alert" style={{ color: colors.redInk, padding: 20 }}>
            {listError}
          </Text>
        ) : (
          <>
            <DesignsCanvas ref={canvas} onMessage={onMessage} />
            {!painted && (
              <Animated.View
                pointerEvents="none"
                exiting={motionScale > 0 ? FadeOut.duration(Math.round(220 * motionScale)) : undefined}
                style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", backgroundColor: colors.surface }]}
              >
                <DrawingDesignIcon />
              </Animated.View>
            )}
          </>
        )}
        {composer && (
          <>
            <Pressable accessibilityLabel="Close the comment" style={StyleSheet.absoluteFill} onPress={() => closeComposer()} />
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
              />
            )}
          </>
        )}
      </View>
    </View>
  );
}

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
// The design icon's strokes (Hugeicons' PaintBoard, as on the design cards) and their lengths in its 24-unit box.
const PALETTE =
  "M22 12C22 6.477 17.523 2 12 2C6.477 2 2 6.477 2 12C2 17.523 6.477 22 12 22C12.842 22 14 22.116 14 21C14 20.391 13.683 19.921 13.369 19.454C12.908 18.772 12.452 18.095 13 17C13.667 15.667 14.778 15.667 16.481 15.667C17.333 15.667 18.333 15.667 19.5 15.5C21.601 15.2 22 13.908 22 12Z";
const PALETTE_LENGTH = 72;
const DOT_LENGTH = 9.5;

/**
 * The design icon drawing itself, stroke by stroke, then fading to draw again: the canvas page does the same in each
 * design's place until it loads. Reduced motion shows it drawn and still.
 */
function DrawingDesignIcon() {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(reduced ? 0.6 : 0);
  useEffect(() => {
    if (reduced) return;
    progress.set(withRepeat(withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.quad) }), -1, false));
  }, [progress, reduced]);
  // Drawn over the first 55%, held, then faded over the last 15%.
  const outline = useAnimatedProps(() => ({ strokeDashoffset: PALETTE_LENGTH * (1 - Math.min(1, progress.value / 0.55)) }));
  const dot = useAnimatedProps(() => ({ strokeDashoffset: DOT_LENGTH * (1 - Math.min(1, progress.value / 0.55)) }));
  const fade = useAnimatedStyle(() => ({ opacity: progress.value > 0.85 ? 1 - (progress.value - 0.85) / 0.15 : 1 }));
  return (
    <Animated.View accessibilityRole="progressbar" accessibilityLabel="Loading the design" style={fade}>
      <Svg width={44} height={44} viewBox="0 0 24 24" fill="none" stroke={colors.ink3} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <AnimatedPath d={PALETTE} strokeDasharray={PALETTE_LENGTH} animatedProps={outline} />
        <AnimatedCircle cx={9.5} cy={8.5} r={1.5} strokeDasharray={DOT_LENGTH} animatedProps={dot} />
        <AnimatedCircle cx={16.5} cy={9.5} r={1.5} strokeDasharray={DOT_LENGTH} animatedProps={dot} />
        <AnimatedCircle cx={7} cy={15} r={0.25} strokeDasharray={DOT_LENGTH} animatedProps={dot} />
      </Svg>
    </Animated.View>
  );
}

/**
 * The canvas page from a cache file of its own. It runs only its fixed script (designsCanvasShell's policy allows it
 * by hash), and each design is a frame that runs none, so nothing a design holds can read the phone's files or post
 * to the app. The Expo modules bridge stays off; the app reads only the canvas script's messages, by their shape.
 */
// On the surface color (white, or the theme's dark surface), like the header, so the bar and the canvas read as one.
function DesignsCanvas({ ref, onMessage }: { ref: React.Ref<DomWebViewRef>; onMessage: (data: string) => void }) {
  const { colors } = useTheme();
  const [crashed, setCrashed] = useState(false);
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const prepared = useMemo(() => {
    const file = new File(Paths.cache, `designs-${id}-${colors.surface.replace(/[^a-zA-Z0-9]/g, "")}.html`);
    try {
      file.writeSync(designsCanvasShell(colors.surface));
      return { file, uri: file.uri };
    } catch {
      return null;
    }
  }, [id, colors.surface]);
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
  if (crashed || !prepared)
    return (
      <Text accessibilityRole="alert" style={{ color: colors.redInk, padding: 20 }}>
        Could not prepare the designs.
      </Text>
    );
  return (
    <DomWebView
      ref={ref}
      source={{ uri: prepared.uri }}
      style={{ flex: 1, backgroundColor: colors.surface }}
      containerStyle={{ flex: 1 }}
      useExpoModulesBridge={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      scrollEnabled={false}
      onMessage={(event) => onMessage(event.nativeEvent.data)}
      onContentProcessDidTerminate={() => setCrashed(true)}
      onRenderProcessGone={() => setCrashed(true)}
    />
  );
}
