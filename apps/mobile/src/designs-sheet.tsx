import { commentActivity } from "./comment-activity";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeOut, useAnimatedProps, useAnimatedStyle, useSharedValue, withRepeat, withTiming, Easing } from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import { File, Paths } from "expo-file-system";
import { Cancel01Icon, CommentAdd01Icon, DashboardSquare01Icon, MoreHorizontalIcon, PlayIcon, Sent02Icon, Share08Icon } from "@hugeicons/core-free-icons";
import {
  artifactDocument,
  designFeedbackMessage,
  designGroups,
  designKitLabel,
  designsCanvasShell,
  isInteractiveDesign,
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
import { CircleButton, ErrorNotice, PullDown, SheetHeader, tap, useStyles } from "./ui";
import { confirmSheet } from "./confirm-store";
import { duration } from "./design-tokens";
import { useReducedMotion } from "./motion";
import { markDesignDeleted } from "./use-design-catalog";
import { onShareAvailability } from "./share-availability";
import { loadCanvasDesign } from "./design-font-cache";
import { CommentBox } from "./viewer-chrome";
import { designActionsMenu, designHtmlIn, designModeLabel, shownDesignMode } from "./design-modes-menu";
import type { DesignMode } from "@milagre/shared/design-modes";
import { useVisibleRunChatKeys } from "./visible-run-chats";

type Note = DesignComment & { key: string };
type CanvasView = { mode: "design" | "canvas"; id: string | null };
type Composer = { key: string; kind: "new" | "edit" | "read"; at: { x: number; y: number } | null };
type CanvasCommand = Record<string, unknown> & { t: string };

const unsent = new Map<string, { notes: Note[]; choice: ArtifactRef | null }>();
const EMPTY_DESIGNS: Record<string, Artifact> = {};

const refOf = (design: Artifact): ArtifactRef => ({ id: design.id, version: design.version, title: design.title, format: design.format });

/** `onClose` is set where the canvas is a tab of the right panel docked beside its Chat (an iPad), and closes the tab. */
export function DesignsSheet({
  hostId,
  chatId,
  id,
  version,
  chosen,
  comment: commentId,
  requestId,
  onClose,
}: {
  hostId?: string;
  chatId?: string;
  id?: string;
  version?: string;
  chosen?: string;
  comment?: string;
  requestId?: string;
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
  const [showResolved, setShowResolved] = useState(false);
  const pendingComment = useRef<string | null>(null);
  // A repeated history tap must work after dismissing the bubble in an already mounted iPad panel.
  useEffect(() => {
    pendingComment.current = commentId ?? null;
    setComposer(null);
    if (commentId && id && version) setVersions((current) => ({ ...current, [id]: Number(version) }));
  }, [commentId, requestId, id, version]);

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

  const revision = commentActivity(snapshot, chatId, "artifact");
  useVisibleRunChatKeys(client, chatId ? [chatId] : []);
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
  }, [source, chatId, revision, reconnects]);
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
  const openShare = () => {
    if (hostId && chatId) router.push({ pathname: "/design-share-sheet", params: { hostId, chatId } });
  };

  const rows = useMemo(() => designGroups(summaries ?? []), [summaries]);
  const ordered = useMemo(() => rows.flatMap((row) => row.designs), [rows]);

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
          if (live && artifact.format === "design" && (artifact.document || isInteractiveDesign(artifact)))
            setLoaded((current) => ({
              source,
              chatId,
              designs: { ...(current.source === source && current.chatId === chatId ? current.designs : {}), [design.id]: artifact },
            }));
        } catch {
        } finally {
          if (inFlight.get(key) === promise) inFlight.delete(key);
        }
      }
    };
    void load(wanted.slice(0, 1)).then(() => {
      if (!live) return;
      const rest = wanted.slice(1);
      for (let lane = 0; lane < 3; lane++) void load(rest.filter((_, index) => index % 3 === lane));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, chatId, summaries, ordered, versions, reconnects]);

  const canvas = useRef<DomWebViewRef>(null);
  const ready = useRef(false);
  const [epoch, setEpoch] = useState(0);
  const [commenting, setCommenting] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const [modes, setModes] = useState<Record<string, DesignMode>>({});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, insets.bottom, colors.ink3, colors.accent, command, epoch]);

  useEffect(() => {
    command({ t: "comment", on: commenting });
  }, [command, epoch, commenting]);

  const chosenId = choice?.id ?? (chosen ? chosen.slice(0, chosen.lastIndexOf(":")) : null);
  useEffect(() => {
    command({ t: "chosen", id: chosenId, ink: colors.ink });
  }, [command, epoch, layoutKey, chosenId, colors.ink]);

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
      const key = `${artifact.version}:${artifact.html.length}:${font ?? ""}:${shownDesignMode(artifact, modes[artifact.id])}`;
      if (sentDocs.current.get(artifact.id) === key) continue;
      sentDocs.current.set(artifact.id, key);
      const code = isInteractiveDesign(artifact);
      command({
        t: "html",
        id: artifact.id,
        doc: artifactDocument(designHtmlIn(artifact, modes[artifact.id]), { code }),
        ...(code ? { run: true } : {}),
        ...(font ? { font } : {}),
      });
    }
  }, [loaded, modes, command, epoch, layoutKey]);

  const numbers = useMemo(() => sentNumbers(sent), [sent]);
  const pins = useMemo(() => {
    const shown = (designId: string) => loaded[designId]?.version;
    const waiting = notes.flatMap((note, index) =>
      note.x === undefined || note.y === undefined || shown(note.design.id) !== note.design.version
        ? []
        : [{ k: note.key, id: note.design.id, x: note.x, y: note.y, n: index + 1, fill: colors.accent, ink: colors.onAccent, label: `Comment ${index + 1}` }],
    );
    const done = sent.flatMap((comment) =>
      comment.x === undefined ||
      comment.y === undefined ||
      shown(comment.design.id) !== comment.design.version ||
      (!showResolved && comment.resolved !== undefined && composer?.key !== `sent:${comment.id}`)
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
  }, [notes, sent, numbers, loaded, composer?.key, showResolved, colors.accent, colors.onAccent, colors.green, colors.ink2, colors.page]);
  const pinsKey = JSON.stringify(pins);
  useEffect(() => {
    command({ t: "pins", pins: JSON.parse(pinsKey) });
  }, [pinsKey, command, epoch, layoutKey]);

  useEffect(() => {
    if (!ready.current || !pendingComment.current) return;
    const comment = sent.find((item) => item.id === pendingComment.current && item.design.id === id);
    if (!comment || comment.x === undefined || comment.y === undefined) return;
    if (loaded[comment.design.id]?.version !== comment.design.version) return;
    pendingComment.current = null;
    setComposer({ key: `sent:${comment.id}`, kind: "read", at: null });
    command({ t: "reveal", id: comment.design.id, x: comment.x, y: comment.y });
  }, [sent, loaded, id, commentId, requestId, epoch, command]);

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
          setPlaying(null);
          sentDocs.current.clear();
          sentFonts.current.clear();
          setEpoch((value) => value + 1);
          return;
        case "painted":
          setPainted(true);
          return;
        case "play":
          setPlaying(typeof message.id === "string" ? message.id : null);
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
    const comments: DesignComment[] = written.map(({ key: _key, ...note }) => ({ ...note, text: note.text.trim(), id: newCommentId() }));
    if (chatKey) unsent.delete(chatKey);
    postDesignMessage(`${hostId}|${chatId}`, {
      kind: "designs",
      text: designFeedbackMessage({ choice, comments }),
      onSent: () => {
        if (!comments.length) return;
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
    setChoice(null);
  };
  const remove = (design: Artifact) =>
    confirmSheet(`Delete ${design.title}?`, "Every version of this design and the comments on it are deleted.", [
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
      { text: "Cancel", style: "cancel" },
    ]);

  const canvasMode = view.mode === "canvas";
  const latest = shown && "latest" in shown ? shown.latest : (summary?.versions ?? 1);
  const menu = designActionsMenu({ shown, latest, showResolved, chosen: pendingHere || sentHere, sent: sentHere, sharing, mode: shown && modes[shown.id] });
  const choose = (action: string) => {
    if (!shown) return;
    if (action === "resolved") setShowResolved(!showResolved);
    else if (action === "choose") setChoice(pendingHere ? null : refOf(shown));
    else if (action === "share") openShare();
    else if (action === "delete") remove(shown);
    else if (action.startsWith("mode:")) setModes((current) => ({ ...current, [shown.id]: action.slice("mode:".length) as DesignMode }));
    else if (action.startsWith("version:")) {
      const number = Number(action.slice("version:".length));
      setVersions((current) => ({ ...current, [shown.id]: number >= latest ? null : number }));
    }
  };

  const position =
    row && summary && row.designs.length > 1
      ? `Option ${row.designs.indexOf(summary) < 26 ? String.fromCharCode(65 + row.designs.indexOf(summary)) : row.designs.indexOf(summary) + 1}`
      : "";
  const title = canvasMode ? "All designs" : (summary?.title ?? shown?.title ?? "Designs");
  const subtitle = canvasMode
    ? `${ordered.length} ${ordered.length === 1 ? "design" : "designs"}${rows.length > 1 ? ` · ${rows.length} screens` : ""}`
    : [
        row?.group,
        position,
        shown ? `v${shown.version}` : "",
        isInteractiveDesign(shown) ? "Interactive" : "",
        designModeLabel(shown, shown && modes[shown.id]),
        designKitLabel(shown),
      ]
        .filter(Boolean)
        .join(" · ");
  const tryable = !canvasMode && isInteractiveDesign(shown);

  const openNote = composer && composer.kind !== "read" ? notes.find((note) => note.key === composer.key) : undefined;
  const openSent = composer?.kind === "read" ? sent.find((comment) => `sent:${comment.id}` === composer.key) : undefined;

  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.surface }}>
      <SheetHeader
        title={title}
        subtitle={subtitle}
        leading={[
          // In the panel docked beside the Chat (an iPad), the panel's own button closes it.
          !onClose && <CircleButton key="close" label="Close designs" icon={Cancel01Icon} onPress={close} />,
          source && ordered.length > 0 && (
            <CircleButton
              key="overview"
              label={canvasMode ? "Open the design" : "All designs"}
              icon={DashboardSquare01Icon}
              selected={canvasMode}
              onPress={() => command(canvasMode && shownId ? { t: "focus", id: shownId } : { t: "overview" })}
            />
          ),
        ].filter(Boolean)}
        trailing={[
          tryable && shown && (
            <CircleButton
              key="try"
              label={playing === shown.id ? "Stop trying the design" : "Try the design"}
              icon={PlayIcon}
              selected={playing === shown.id}
              onPress={() => {
                closeComposer();
                if (playing !== shown.id) setCommenting(false);
                command({ t: "play", id: playing === shown.id ? null : shown.id });
              }}
            />
          ),
          source && (
            <CircleButton
              key="comment"
              label={commenting ? "Stop commenting" : "Comment on a design"}
              icon={CommentAdd01Icon}
              selected={commenting}
              onPress={() => {
                closeComposer();
                setCommenting((value) => !value);
              }}
            />
          ),
          source && feedback > 0 && (
            <CircleButton key="send" label={`Send ${feedback} to the agent`} icon={Sent02Icon} onPress={send} filled badge={feedback} />
          ),
          canvasMode
            ? sharing && <CircleButton key="share" label="Share page" icon={Share08Icon} onPress={openShare} />
            : source &&
              shown && (
                <PullDown key="actions" label="Design actions" sections={menu} onSelect={choose}>
                  <CircleButton label="Design actions" icon={MoreHorizontalIcon} asTrigger />
                </PullDown>
              ),
        ].filter(Boolean)}
      />
      <View style={{ flex: 1 }} onLayout={(event) => setRoom(event.nativeEvent.layout)}>
        {!matching ? (
          <Text style={[styles.muted, { padding: 16 }]}>Reconnect to your computer to open this page.</Text>
        ) : feature.enabled !== true ? (
          <View style={{ padding: 16 }}>
            {feature.enabled !== false && feature.error ? (
              <ErrorNotice message={feature.error} retry={() => void feature.refresh()} retryTitle="Retry" />
            ) : (
              <Text style={styles.muted}>
                {feature.enabled === false
                  ? "Designs is off for this computer. Update Milagre on the computer to use Designs."
                  : "Checking whether Designs is available…"}
              </Text>
            )}
          </View>
        ) : listError && !summaries ? (
          <View style={{ padding: 16 }}>
            <ErrorNotice message={listError} />
          </View>
        ) : (
          <>
            <DesignsCanvas ref={canvas} onMessage={onMessage} />
            {!painted && (
              <Animated.View
                pointerEvents="none"
                exiting={motionScale > 0 ? FadeOut.duration(Math.round(duration.base * motionScale)) : undefined}
                style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", backgroundColor: colors.surface }]}
              >
                <DrawingDesignIcon />
              </Animated.View>
            )}
          </>
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
                room={room.width ? room : undefined}
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
const PALETTE =
  "M22 12C22 6.477 17.523 2 12 2C6.477 2 2 6.477 2 12C2 17.523 6.477 22 12 22C12.842 22 14 22.116 14 21C14 20.391 13.683 19.921 13.369 19.454C12.908 18.772 12.452 18.095 13 17C13.667 15.667 14.778 15.667 16.481 15.667C17.333 15.667 18.333 15.667 19.5 15.5C21.601 15.2 22 13.908 22 12Z";
const PALETTE_LENGTH = 72;
const DOT_LENGTH = 9.5;
const DRAW_MS = 1800;
const PULSE_MS = 1600;

function DrawingDesignIcon() {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.set(0);
    progress.set(
      withRepeat(withTiming(1, reduced ? { duration: PULSE_MS, easing: Easing.linear } : { duration: DRAW_MS, easing: Easing.inOut(Easing.quad) }), -1, false),
    );
  }, [progress, reduced]);
  const drawn = (length: number) => {
    "worklet";
    return reduced ? 0 : length * (1 - Math.min(1, progress.value / 0.55));
  };
  const outline = useAnimatedProps(() => ({ strokeDashoffset: drawn(PALETTE_LENGTH) }));
  const dot = useAnimatedProps(() => ({ strokeDashoffset: drawn(DOT_LENGTH) }));
  const fade = useAnimatedStyle(() => ({
    // oxlint-disable-next-line milagre-design/opacity-token -- animation: the palette icon's fade-out, not a press or disabled state
    opacity: reduced ? (progress.value < 0.5 ? 1 : 0.45) : progress.value > 0.85 ? 1 - (progress.value - 0.85) / 0.15 : 1,
  }));
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
      } catch {}
    },
    [prepared],
  );
  if (crashed || !prepared)
    return (
      <View style={{ padding: 16 }}>
        <ErrorNotice message="Could not prepare the designs." />
      </View>
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
