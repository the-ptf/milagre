import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, AppState, Pressable, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { DomWebView } from "@expo/dom-webview";
import { ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon, CheckmarkCircle02Icon, Delete02Icon, PaintBoardIcon } from "@hugeicons/core-free-icons";
import {
  artifactShell,
  designFeedbackMessage,
  designFeedbackText,
  newCommentId,
  type Artifact,
  type ArtifactComment,
  type ArtifactSummary,
  type DesignComment,
  resolutionNotes,
} from "@milagre/shared/artifact";
import type { ArtifactRef } from "@milagre/shared/model";
import type { ArtifactStep } from "@milagre/shared/reply-parts";
import { postDesignMessage } from "./design-outbox";
import { File, Paths } from "expo-file-system";
import { useSession } from "./session";
import { useArtifactCatalog } from "./use-design-catalog";
import { markDesignDeleted } from "./design-catalog";
import { Icon } from "./icons";
import { CircleButton, PillButton, useStyles } from "./ui";
import { useTheme } from "./theme";
import { DesignPageShareSheet } from "./design-page-share";

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
                  borderRadius: 10,
                  borderBottomLeftRadius: 0,
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
        router.push({
          pathname: "/artifact-sheet",
          params: {
            hostId: client!.url,
            chatId: chatId!,
            id: first.id,
            version: String(first.version),
            ...(chosen ? { chosen } : {}),
          },
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

/** A design the agent showed. It opens the Chat's designs full screen; a saved Chat is needed to read them. */
function ArtifactCard({ step, chatId, chosen, kind = "design" }: { step: ArtifactStep; chatId?: string; chosen?: string; kind?: "design" | "html" }) {
  const { colors } = useTheme();
  const { client, designs: feature } = useSession();
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
        router.push({
          pathname: "/artifact-sheet",
          params: {
            hostId: client!.url,
            chatId: chatId!,
            id,
            ...(kind === "html" ? { kind } : {}),
            ...(kind === "design" ? { version: String(version) } : {}),
            ...(chosen ? { chosen } : {}),
          },
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
        <Icon icon={PaintBoardIcon} tone="ink2" size={18} />
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

/**
 * The Chat's designs full screen, the one a card opened first. The header steps between designs and the bar under the
 * design steps through its versions, comments on it, or chooses it. Comments and the choice wait for Send, which hands
 * them to the Chat as one message for the agent.
 */
export function ArtifactSheet({
  hostId,
  chatId,
  id,
  version,
  chosen,
  kind,
}: {
  hostId?: string;
  chatId?: string;
  id?: string;
  version?: string;
  chosen?: string;
  kind?: string;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { client, designs: feature, snapshot } = useSession();
  const insets = useSafeAreaInsets();
  const matching = client && chatId && id && (!hostId || hostId === client.url) ? client : null;
  const [state, setState] = useState<{
    artifact: Artifact | null;
    error: string;
  }>({ artifact: null, error: "" });
  const isHtml = state.artifact?.format === "html" || (!state.artifact && kind === "html");
  const shareKind = isHtml ? "artifacts" : "designs";
  const source = !isHtml && state.artifact?.format === "design" && feature.enabled !== true ? null : matching;
  const sharingScope = useMemo(() => ({ source, chatId, shareKind }), [source, chatId, shareKind]);
  const [sharingAvailable, setSharingAvailable] = useState<typeof sharingScope | null>(null);
  const sharingRequest = useRef(0);
  const sharingStatusChanged = useCallback(
    (available: boolean | null) => {
      sharingRequest.current++;
      setSharingAvailable(available === true ? sharingScope : null);
    },
    [sharingScope],
  );
  useEffect(() => {
    if (!source) return;
    let live = true;
    const refresh = () => {
      const current = ++sharingRequest.current;
      setSharingAvailable(null);
      source
        .call<{ available: boolean }>("artifact:sharing-status", shareKind === "artifacts" ? [{ kind: shareKind }] : [])
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
  }, [source, sharingScope, shareKind]);
  const [designs, setDesigns] = useState<ArtifactSummary[] | null>(null);
  const [shown, setShown] = useState<{ id: string; version: number | null }>({
    id: id ?? "",
    version: version ? Number(version) : null,
  });
  const [revision, setRevision] = useState(0);
  const pageRevision =
    isHtml && chatId
      ? snapshot?.runs.runs[chatId]?.steps
          .filter((step) => step.kind === "artifact" && step.status === "done")
          .map((step) => step.id)
          .join("|")
      : undefined;
  useEffect(() => {
    if (!isHtml) return;
    const watch = AppState.addEventListener("change", (status) => {
      if (status === "active") setRevision((value) => value + 1);
    });
    return () => watch.remove();
  }, [isHtml]);
  const [sharePage, setSharePage] = useState(false);
  // Feedback waits here until Send: a comment per design version, and the design the user chose.
  const [editing, setEditing] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, DesignComment>>({});
  const [choice, setChoice] = useState<ArtifactRef | null>(null);
  useEffect(() => {
    if (feature.enabled === false && state.artifact?.format === "design") router.back();
  }, [feature.enabled, state.artifact?.format]);
  useEffect(() => {
    if (!source) return;
    let live = true;
    source
      .call<ArtifactSummary[]>("artifact:list", [{ chatId }])
      .then((list) => live && setDesigns(list.filter((design) => design.format === "design")))
      .catch(() => live && setDesigns(null));
    return () => {
      live = false;
    };
  }, [source, chatId]);
  useEffect(() => {
    if (!source || !shown.id) return;
    let live = true;
    source
      .call<Artifact>("artifact:get", [
        {
          chatId,
          id: shown.id,
          ...(shown.version === null ? {} : { version: shown.version }),
        },
      ])
      .then((artifact) => {
        if (artifact.format !== "html" && (artifact.format !== "design" || !artifact.document)) throw new Error("This page is no longer available.");
        if (live) setState({ artifact, error: "" });
      })
      .catch(
        (error: unknown) =>
          live &&
          setState({
            artifact: null,
            error: error instanceof Error ? error.message : "Could not load this page.",
          }),
      );
    return () => {
      live = false;
    };
  }, [source, chatId, shown, revision, pageRevision]);
  const artifact = source && (state.artifact?.format === "html" || state.artifact?.id === shown.id) ? state.artifact : null;
  const index = designs?.findIndex((design) => design.id === shown.id) ?? -1;
  const step = (offset: number) => {
    const next = designs?.[index + offset];
    if (!next) return;
    setEditing(null);
    setShown({ id: next.id, version: null });
  };
  const current = artifact?.version ?? shown.version ?? 1;
  const key = artifact ? `${artifact.id}:${artifact.version}` : "";
  const pendingHere = !!artifact && choice?.id === artifact.id && choice.version === artifact.version;
  const sentHere = !choice && chosen === key;
  const written = Object.values(notes).filter((note) => note.text.trim());
  const feedback = written.length + (choice ? 1 : 0);
  const send = async () => {
    if (!hostId || !chatId || !feedback || !source) return;
    // Each comment gets the id the agent resolves it by; the host records the comments once the message went.
    const comments = written.map((note) => ({ ...note, id: newCommentId() }));
    postDesignMessage(`${hostId}|${chatId}`, {
      kind: isHtml ? "artifacts" : "designs",
      text: designFeedbackMessage({ choice, comments }),
      onSent: () => {
        if (comments.length) source.call("artifact:add-comments", [{ chatId, comments }]).catch(() => {});
      },
    });
    router.back();
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
              setNotes((current) => Object.fromEntries(Object.entries(current).filter(([, note]) => note.design.id !== design.id)));
              setChoice((current) => (current?.id === design.id ? null : current));
              setEditing(null);
              const rest = designs?.filter((item) => item.id !== design.id) ?? [];
              // The next design takes its place, or the one before when it was the last.
              const next = designs?.[index + 1] ?? designs?.[index - 1];
              setDesigns(rest);
              if (next && next.id !== design.id) setShown({ id: next.id, version: null });
              else router.back();
            })
            .catch((error: unknown) => Alert.alert("Could not delete the design", error instanceof Error ? error.message : String(error)));
        },
      },
    ]);
  const ref = (design: Artifact): ArtifactRef => ({
    id: design.id,
    version: design.version,
    title: design.title,
    format: design.format,
  });
  return (
    // The bar under the design rises with the keyboard, so a comment being written stays in view.
    // The keyboard covers the home indicator, so the bar's bottom inset gives way to its 12pt gap while it is up.
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={-Math.max(insets.bottom - 12, 0)}
      style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.page }}
    >
      {sharePage && source && chatId ? (
        <DesignPageShareSheet
          key={`${source.url}:${chatId}:${shareKind}`}
          client={source}
          chatId={chatId}
          kind={shareKind}
          onClose={() => setSharePage(false)}
          onAvailabilityChange={sharingStatusChanged}
        />
      ) : (
        <>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 8,
              gap: 8,
            }}
          >
            {source && !isHtml && <CircleButton label="Previous design" icon={ArrowLeft01Icon} onPress={index > 0 ? () => step(-1) : undefined} />}
            <View style={{ flex: 1, alignItems: "center" }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
                  {isHtml ? "Artifact" : "Designs"}
                </Text>
                {source && !isHtml && (
                  <Text
                    style={{
                      color: colors.ink2,
                      backgroundColor: colors.canvas,
                      borderRadius: 5,
                      paddingHorizontal: 5,
                      paddingVertical: 2,
                      fontSize: 10,
                    }}
                  >
                    Experimental
                  </Text>
                )}
              </View>
              {artifact && (
                <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 13 }}>
                  {artifact.title}
                </Text>
              )}
              {source && !isHtml && designs && designs.length > 1 && index >= 0 && (
                <Text style={{ color: colors.ink3, fontSize: 11 }}>
                  Design {index + 1} of {designs.length}
                </Text>
              )}
              {source && sharingAvailable === sharingScope && (isHtml ? !!artifact : designs && designs.length > 0 && feature.enabled === true) && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={isHtml ? "Share artifact" : "Share Designs page"}
                  onPress={() => setSharePage(true)}
                  style={{ paddingHorizontal: 12, paddingVertical: 8 }}
                >
                  <Text
                    style={{
                      color: colors.accent,
                      fontSize: 13,
                      fontWeight: "500",
                    }}
                  >
                    Share page
                  </Text>
                </Pressable>
              )}
            </View>
            {source && !isHtml && (
              <CircleButton
                label="Next design"
                icon={ArrowRight01Icon}
                onPress={designs && index >= 0 && index < designs.length - 1 ? () => step(1) : undefined}
              />
            )}
            {source && !isHtml && artifact?.format === "design" && (
              <CircleButton label={`Delete ${artifact.title}`} icon={Delete02Icon} onPress={() => remove(artifact)} />
            )}
            <CircleButton label={isHtml ? "Close artifact" : "Close designs"} icon={Cancel01Icon} onPress={() => router.back()} />
          </View>
          <View style={{ flex: 1 }}>
            {!matching ? (
              <Text style={[styles.muted, { padding: 20 }]}>Reconnect to this Mac to open this page.</Text>
            ) : !isHtml && state.artifact?.format === "design" && feature.enabled !== true ? (
              <View style={{ padding: 20, gap: 16 }}>
                <Text style={styles.muted}>
                  {feature.enabled === false
                    ? "Designs is off for this Mac. Turn it on in Settings > Experimental."
                    : feature.error || "Checking whether Designs is available..."}
                </Text>
                {feature.error && <PillButton title="Retry" onPress={() => void feature.refresh()} />}
              </View>
            ) : state.error ? (
              <View style={{ padding: 20, gap: 16 }}>
                <Text accessibilityRole="alert" style={{ color: colors.red }}>
                  {state.error}
                </Text>
                <PillButton title="Retry" onPress={() => setRevision((value) => value + 1)} />
              </View>
            ) : artifact ? (
              <ArtifactWebView key={`${artifact.id}:${artifact.version}`} html={artifact.html} />
            ) : (
              <Text style={[styles.muted, { padding: 20 }]}>Loading page...</Text>
            )}
          </View>
          {artifact && (
            <View
              style={{
                paddingHorizontal: 16,
                paddingTop: 10,
                paddingBottom: Math.max(insets.bottom, 12),
                gap: 10,
                borderTopWidth: 1,
                borderColor: colors.line,
              }}
            >
              {/* Its own row, the width of the bar: beside the version and choice controls it would not fit a phone. */}
              {editing !== key && feedback > 0 && <PillButton title={`Send ${feedback}`} onPress={send} />}
              {editing !== key ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  {!isHtml && (
                    <>
                      <CircleButton
                        label={`Previous version of ${artifact.title}`}
                        icon={ArrowLeft01Icon}
                        onPress={
                          current > 1
                            ? () =>
                                setShown({
                                  id: artifact.id,
                                  version: current - 1,
                                })
                            : undefined
                        }
                      />
                      <Text
                        style={{
                          color: colors.ink3,
                          fontSize: 13,
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        v{current} of {artifact.latest}
                      </Text>
                      <CircleButton
                        label={`Next version of ${artifact.title}`}
                        icon={ArrowRight01Icon}
                        onPress={
                          current < artifact.latest
                            ? () =>
                                setShown({
                                  id: artifact.id,
                                  version: current + 1 === artifact.latest ? null : current + 1,
                                })
                            : undefined
                        }
                      />
                    </>
                  )}
                  <View style={{ flex: 1 }} />
                  <PillButton title={notes[key]?.text.trim() ? "Comment ✓" : "Comment"} secondary onPress={() => setEditing(key)} />
                  {!isHtml &&
                    (sentHere ? (
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <Icon icon={CheckmarkCircle02Icon} tone="accent" size={16} />
                        <Text style={{ color: colors.accent, fontSize: 14 }}>Chosen</Text>
                      </View>
                    ) : (
                      <PillButton title={pendingHere ? "Chosen ✓" : "Choose"} secondary onPress={() => setChoice(pendingHere ? null : ref(artifact))} />
                    ))}
                </View>
              ) : (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "flex-end",
                    gap: 8,
                  }}
                >
                  <TextInput
                    // Uncontrolled: the bar moves with the keyboard as it types, and a controlled value written back
                    // during those renders drops keystrokes.
                    key={key}
                    accessibilityLabel={`Comment on ${artifact.title}`}
                    autoFocus
                    multiline
                    defaultValue={notes[key]?.text ?? ""}
                    onChangeText={(text) =>
                      setNotes((currentNotes) => ({
                        ...currentNotes,
                        [key]: {
                          ...currentNotes[key],
                          design: ref(artifact),
                          text,
                        },
                      }))
                    }
                    placeholder="What should change?"
                    placeholderTextColor={colors.ink3}
                    selectionColor={colors.accent}
                    style={[styles.input, { flex: 1, maxHeight: 120 }]}
                  />
                  <CircleButton
                    label="Delete comment"
                    icon={Cancel01Icon}
                    onPress={() => {
                      setNotes(({ [key]: _removed, ...rest }) => rest);
                      setEditing(null);
                    }}
                  />
                  <PillButton title="Done" onPress={() => setEditing(null)} />
                </View>
              )}
            </View>
          )}
        </>
      )}
    </KeyboardAvoidingView>
  );
}

/**
 * The design inside artifactShell, from a cache file of its own. The page has no script; the design runs in its
 * sandboxed frame with an opaque origin, so it can't read the phone's files (this web view grants a file: page read
 * access to all of them), make requests, or navigate the page or its own frame away. The Expo modules bridge stays
 * off, and nothing the page posts is read.
 */
function ArtifactWebView({ html }: { html: string }) {
  const { colors } = useTheme();
  const [crashed, setCrashed] = useState(false);
  // Written while rendering, so the page is there on the first frame; each design gets a file of its own, removed
  // when the design changes or goes.
  // Named for this view and the design's content: two views never share a file, and a changed design gets a new one.
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const prepared = useMemo(() => {
    let hash = 5381;
    for (let index = 0; index < html.length; index++) hash = (hash * 33) ^ html.charCodeAt(index);
    const file = new File(Paths.cache, `artifact-${id}-${(hash >>> 0).toString(36)}.html`);
    try {
      file.write(artifactShell(html));
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
  const failed = crashed || !prepared;
  const uri = prepared?.uri;
  if (failed)
    return (
      <Text accessibilityRole="alert" style={{ color: colors.red, padding: 20 }}>
        Could not prepare this page.
      </Text>
    );
  if (!uri) return null;
  return (
    <DomWebView
      source={{ uri }}
      style={{ flex: 1, backgroundColor: "#ffffff" }}
      containerStyle={{ flex: 1 }}
      useExpoModulesBridge={false}
      allowsInlineMediaPlayback
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      onContentProcessDidTerminate={() => setCrashed(true)}
      onRenderProcessGone={() => setCrashed(true)}
    />
  );
}
