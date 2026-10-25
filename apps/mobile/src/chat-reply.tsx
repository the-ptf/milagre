import { memo, useCallback, useMemo, useEffect, useRef, useState } from "react";
import { Image, Pressable, Text, View, type ImageSourcePropType, type ViewInstance } from "react-native";
import Svg, { Path } from "react-native-svg";
import { router } from "expo-router";
import { Alert02Icon, ArrowRight01Icon, Link04Icon } from "@hugeicons/core-free-icons";
import type { AgentRun } from "@milagre/shared/agent-runs";
import type { ChatMessage, ChatStep, LinkedContext } from "@milagre/shared/model";
import { linkedContext, linkedHeading } from "@milagre/shared/linked-message";
import { activitySummary, replyActivity, unspokenThought } from "@milagre/shared/reply-parts";
import { FileChip } from "./file-chip";
import { onlyImageMentions, promptParts } from "@milagre/shared/prompt-parts";
import { isMentionOfFile, mentionedFile, mentionedFiles } from "@milagre/shared/prompt-mentions";
import { FileMentionChip, ImageMentionChip, SkillChip } from "./prompt-chip";
import { promptAccessibilityLabel } from "./prompt-label";
import { useSkillNames } from "./use-skill-names";
import { Markdown } from "./markdown";
import { MessageActions, messageActionProps, selectableMessageText } from "./message-actions";
import { Icon } from "./icons";
import { ActivityTitle } from "./activity-item";
import { ToolRow } from "./tool-row";
import { ArtifactCards, DesignFeedbackCard } from "./artifact";
import { AdvisorResultCard } from "./advisor-result-card";
import { parseDesignFeedback } from "@milagre/shared/artifact";
import { AnswerCard } from "./answer-card";
import { useToolCallDisplay } from "./chat-display-setting";
import { PullRequestActionCard } from "./pr-action-card";
import { isPullRequestAction } from "@milagre/shared/pr-action";
import { isLinearIssueContext } from "@milagre/shared/linear-issue";
import { LinearIssueCard } from "./linear-issue-card";
import { HeartbeatCard } from "./heartbeat-card";
import { usageLimitOf } from "@milagre/shared/usage-limit";
import { UsageLimitCard } from "./usage-limit-card";
import { useTheme } from "./theme";
import { useStyles } from "./ui";
import { showImages, type MediaValue, type ViewerImage } from "./viewer-store";

/** Resolves a saved file on the computer to an authenticated image source, or a cached file once it is fetched. */
export type MediaSource = (path: string) => MediaValue;

/** The image to show now: a ready source as is, a loading one once it arrives (null until then, or if it fails). */
export function useMedia(source: MediaValue | null): ImageSourcePropType | null {
  const pending = typeof (source as Promise<ImageSourcePropType> | null)?.then === "function" ? (source as Promise<ImageSourcePropType>) : null;
  const [loaded, setLoaded] = useState<{ from: Promise<ImageSourcePropType>; value: ImageSourcePropType | null } | null>(null);
  useEffect(() => {
    if (!pending) return;
    let current = true;
    pending.then(
      (value) => {
        if (current) setLoaded({ from: pending, value });
      },
      () => {
        if (current) setLoaded({ from: pending, value: null });
      },
    );
    return () => {
      current = false;
    };
  }, [pending]);
  if (!pending) return source as ImageSourcePropType | null;
  return loaded?.from === pending ? loaded.value : null;
}
/** Measures every thumbnail first, so the viewer morphs out of the tapped one and back into whichever is showing. */
function open(images: ViewerImage[], index: number, thumbs: (ViewInstance | null)[]) {
  void Promise.all(
    images.map(
      (image, i) =>
        new Promise<ViewerImage>((resolve) => {
          const thumb = thumbs[i];
          if (!thumb) {
            resolve(image);
            return;
          }
          thumb.measureInWindow((x, y, width, height) => resolve(width && height ? { ...image, from: { x, y, width, height } } : image));
        }),
    ),
  ).then((measured) => {
    showImages(measured, index);
    router.push("/viewer");
  });
}

function viewerPhotos(message: ChatMessage, media: MediaSource): ViewerImage[] {
  return (message.images || []).map((photo) => ({
    name: photo.name,
    source: photo.dataUrl ? { uri: photo.dataUrl } : photo.path ? media(photo.path) : { uri: "" },
  }));
}

/** Your photos above your bubble: one large, or tiles; tapping opens the full-screen viewer. */
function Photos({ message, media }: { message: ChatMessage; media: MediaSource }) {
  const { colors } = useTheme();
  const photos = viewerPhotos(message, media);
  const thumbs = useRef<(ViewInstance | null)[]>([]);
  if (!photos.length) return null;
  const single = photos.length === 1;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, justifyContent: "flex-end", maxWidth: 264 }}>
      {photos.map((photo, index) => (
        <Pressable
          key={index}
          ref={(view) => {
            thumbs.current[index] = view;
          }}
          accessibilityRole="imagebutton"
          accessibilityLabel={`${photo.name}. Open full screen`}
          onPress={() => open(photos, index, thumbs.current)}
        >
          <Thumbnail source={photo.source} size={single ? 220 : 130} />
          <View
            style={{
              position: "absolute",
              left: 6,
              top: 6,
              borderRadius: 5,
              paddingHorizontal: 5,
              paddingVertical: 1,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.line,
            }}
          >
            <Text style={{ fontSize: 10, fontWeight: "600", color: colors.ink }}>#{index + 1}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}
/** One photo tile; a relay image shows the empty tile until its file is ready. */
function Thumbnail({ source, size }: { source: MediaValue; size: number }) {
  const { colors } = useTheme();
  const ready = useMedia(source);
  const style = { width: size, height: size, borderRadius: 14, backgroundColor: colors.canvas };
  return ready ? <Image source={ready} resizeMode="cover" style={style} /> : <View style={style} />;
}
/** An image the agent generated, under its step, at most 240 wide; tap for full screen. */
function GeneratedImage({ step, media }: { step: ChatStep; media: MediaSource }) {
  const { colors } = useTheme();
  const [ratio, setRatio] = useState(4 / 5);
  const thumb = useRef<ViewInstance>(null);
  const shown = !!step.file && step.status === "done";
  const source = shown ? media(step.file!) : null;
  const ready = useMedia(source);
  if (!shown || !source) return null;
  const image: ViewerImage = { source, name: step.file!.split("/").pop() || "Generated image" };
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel="Image. Open full screen"
      ref={thumb}
      onPress={() => open([image], 0, [thumb.current])}
      style={{ width: 240 }}
    >
      {ready ? (
        <Image
          source={ready}
          onLoad={({ nativeEvent }) => {
            const { width, height } = nativeEvent.source;
            if (width && height) setRatio(width / height);
          }}
          style={{ width: 240, aspectRatio: ratio, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.canvas }}
        />
      ) : (
        <View style={{ width: 240, aspectRatio: ratio, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.canvas }} />
      )}
    </Pressable>
  );
}
const SPARKLE = "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z";
/** Desktop's ActivityBlock header: a sparkle, the running step's shimmering title or the summary, and failures. */
function ActivityRow({ steps, live, waiting, onPress }: { steps: ChatStep[]; live: boolean; waiting: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const current = live ? steps.findLast((step) => step.status === "running") : undefined;
  const summary = activitySummary(steps);
  const label = current ? current.title : summary.text || "Activity";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label.replace(/`/g, "")}${waiting ? ", waiting for approval" : ""}${!current && summary.failed ? `, ${summary.failed} failed` : ""}. Show activity`}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 36, opacity: pressed ? 0.5 : 1 })}
    >
      <Svg width={16} height={16} viewBox="0 0 24 24">
        <Path d={SPARKLE} fill={current ? colors.ink2 : colors.ink3} />
      </Svg>
      <View style={{ flexShrink: 1 }}>
        {current ? (
          <ActivityTitle key={current.id} title={current.title} startedAt={current.startedAt} shimmer={!waiting} style={{ color: colors.ink2, fontSize: 14 }} />
        ) : (
          <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 14 }}>
            {label}
          </Text>
        )}
      </View>
      {waiting && <Text style={{ color: colors.ink3, fontSize: 12.5 }}>Waiting for approval</Text>}
      {!current && summary.failed > 0 && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon icon={Alert02Icon} tone="red" size={13} />
          <Text style={{ color: colors.red, fontSize: 12.5 }}>{summary.failed} failed</Text>
        </View>
      )}
      <View style={{ flex: 1 }} />
      <Icon icon={ArrowRight01Icon} tone="ink3" size={12} />
    </Pressable>
  );
}
/** The sender line over a message another Chat sent, as on desktop: who it's from, and a tap to open that Chat. */
function LinkedHeader({ context, onOpenChat }: { context: LinkedContext; onOpenChat?: (chatKey: string) => void }) {
  const { colors } = useTheme();
  const { text, chat } = linkedHeading(context);
  const open = chat && onOpenChat ? () => onOpenChat(chat) : undefined;
  return (
    <Pressable
      accessibilityRole={open ? "link" : undefined}
      accessibilityHint={open ? "Opens that Chat" : undefined}
      disabled={!open}
      onPress={open}
      style={{ flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", maxWidth: "100%" }}
    >
      <Icon icon={Link04Icon} color={open ? colors.accentInk : colors.ink3} size={13} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: open ? colors.accentInk : colors.ink3, fontSize: 12, fontWeight: "500" }}>
        {text}
      </Text>
    </Pressable>
  );
}

function openMention(path: string, attached: string[], root: string) {
  const file = mentionedFile(path, attached, root);
  if (file) router.push({ pathname: "/file-preview", params: { path: file } });
}

export const ChatReply = memo(function ChatReply({
  message,
  run,
  onActivity,
  media,
  basePath,
  chatId,
  designChoice,
  designsMoved,
  limitProjectPath,
  highlighted = false,
  onOpenChat,
}: {
  message?: ChatMessage;
  /** Opens another Chat by its key, from the sender line of a message that Chat sent. */
  onOpenChat?: (chatKey: string) => void;
  /** The task in Undo changes' view: its message is outlined, as on desktop. */
  highlighted?: boolean;
  run?: AgentRun;
  onActivity: (message: string) => void;
  media: MediaSource;
  basePath?: string;
  /** The Chat's key, to open the designs its replies showed. */
  chatId?: string;
  /** The design the user last chose, as "id:version". */
  designChoice?: string;
  /** How far the Chat has come (its message count), to read the agent's resolutions of comments again. */
  designsMoved?: number;
  /** Set when a usage-limit reply is the Chat's last message with no turn running: its card then offers other accounts for this Project. */
  limitProjectPath?: string;
}) {
  const { colors, textPx } = useTheme();
  const styles = useStyles();
  const skillNames = useSkillNames(message?.role === "user" ? basePath : undefined);
  const userText = message?.role === "user" ? (run?.text ?? message.body ?? "") : "";
  const userFiles = message?.files;
  const userImages = message?.images?.length ?? 0;
  const userParts = useMemo(
    () => promptParts(userText, { skills: skillNames, files: isMentionOfFile(userFiles ?? [], basePath ?? ""), images: userImages }),
    [userText, skillNames, userFiles, basePath, userImages],
  );
  const [toolCallDisplay] = useToolCallDisplay();
  const savedMedia = useCallback((path: string) => media(message?.images?.find((image) => image.sourcePath === path)?.path || path), [media, message?.images]);
  const openActivity = () => onActivity(message ? String(message.id) : "run");
  const text = run?.text ?? message?.body ?? "";
  const allSteps = run?.steps ?? message?.steps ?? [];
  // A heartbeat_create step that set a Heartbeat shows as its card, not as one more activity row.
  const reply = replyActivity(text, allSteps);
  const heartbeats = reply.heartbeats;
  const waiting = !!(run?.approvals.length || run?.questions.length);
  // Feedback sent from the design sheet or canvas shows as a card, not as the text the agent reads.
  const feedback = message?.role === "user" ? parseDesignFeedback(text) : null;
  // So does a PR-blocker pill's action, instead of the skill prompt the agent read.
  const prAction = message?.role === "user" && isPullRequestAction(message.context) ? message.context : null;
  // And a Chat's first message when it was started from a Linear issue.
  const issue = message?.role === "user" && isLinearIssueContext(message.context) ? message.context : null;
  // What the agent concluded only in thinking, once the turn ends or stops on a question.
  const thought = !run || run.questions.length ? unspokenThought(text, allSteps) : "";
  const limit = !run && message?.role === "assistant" ? usageLimitOf(message) : null;
  const advisor = typeof message?.context === "object" && message.context?.kind === "advisor-result" ? message.context : null;
  // A message another Chat sent (a Delegation, its report, a Negotiation's agreement) carries its sender, never reads as
  // the user's own.
  const linked = linkedContext(message);
  if (advisor)
    return (
      <View style={{ paddingVertical: 8 }}>
        <AdvisorResultCard context={advisor} body={text} highlighted={highlighted} media={savedMedia} basePath={basePath} />
      </View>
    );
  if (message?.role === "user" && linked)
    return (
      <View style={{ gap: 6, paddingVertical: 4 }}>
        <LinkedHeader context={linked} onOpenChat={onOpenChat} />
        <MessageActions text={text}>
          {(openActions) => (
            <View
              style={{
                borderWidth: 1,
                borderColor: colors.line,
                borderRadius: 14,
                borderCurve: "continuous",
                paddingVertical: 10,
                paddingHorizontal: 14,
                ...(highlighted ? { outlineWidth: 1.5, outlineColor: colors.accent, outlineStyle: "solid" as const } : {}),
              }}
            >
              <Text
                selectable={selectableMessageText}
                style={{ color: colors.ink, fontSize: textPx, lineHeight: Math.round(textPx * 1.4667) }}
                {...messageActionProps(openActions)}
              >
                {text}
              </Text>
            </View>
          )}
        </MessageActions>
      </View>
    );
  if (message?.role === "user") {
    const root = basePath ?? "";
    const attached = message.files ?? [];
    // A file the text names with @ shows as a chip in the text, so it gets no tile of its own.
    const inline = mentionedFiles(text, attached, root);
    const parts = userParts;
    const lineHeight = Math.round(textPx * 1.4667);
    return (
      <View style={{ alignSelf: "flex-end", alignItems: "flex-end", gap: 6, maxWidth: "88%" }}>
        <Photos message={message} media={media} />
        {message.files
          ?.filter((file) => !inline.has(file) && !message.images?.some((image) => image.path === file || image.sourcePath === file))
          .map((file) => (
            <FileChip key={file} path={file} />
          ))}
        {prAction ? (
          <PullRequestActionCard action={prAction} />
        ) : issue ? (
          <LinearIssueCard issue={issue} />
        ) : feedback ? (
          <DesignFeedbackCard feedback={feedback} chatId={chatId} moved={designsMoved} />
        ) : message.answered?.length ? (
          <AnswerCard answered={message.answered} />
        ) : (
          // A send that is only its images shows them above, without an "Image #1" bubble.
          !!text &&
          !onlyImageMentions(text, userImages) && (
            <MessageActions text={text}>
              {(openActions) => (
                <View
                  style={{
                    backgroundColor: colors.canvas,
                    borderRadius: 18,
                    borderCurve: "continuous",
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                    ...(highlighted ? { outlineWidth: 1.5, outlineColor: colors.accent, outlineStyle: "solid" as const } : {}),
                  }}
                >
                  <Text
                    selectable={selectableMessageText}
                    accessibilityLabel={promptAccessibilityLabel(parts)}
                    style={{ color: colors.ink, fontSize: textPx, lineHeight }}
                    {...messageActionProps(openActions)}
                  >
                    {parts.map((part, index) =>
                      part.kind === "skill" ? (
                        <SkillChip key={index} name={part.name} />
                      ) : part.kind === "file" ? (
                        <FileMentionChip key={index} path={part.path} onOpen={() => openMention(part.path, attached, root)} />
                      ) : part.kind === "image" ? (
                        <ImageMentionChip key={index} index={part.index} onOpen={() => open(viewerPhotos(message, media), part.index - 1, [])} />
                      ) : (
                        part.text
                      ),
                    )}
                  </Text>
                </View>
              )}
            </MessageActions>
          )
        )}
      </View>
    );
  }
  return (
    <View style={{ gap: 14, paddingVertical: 8 }}>
      {linked && <LinkedHeader context={linked} onOpenChat={onOpenChat} />}
      {reply.setup.map((step) => (
        <ToolRow key={step.id} step={step} live={!!run} waiting={waiting} onPress={openActivity} />
      ))}
      {/* Full detail (Settings › Chat › Tool call display): every tool call is its own row, with the notes between them. */}
      {toolCallDisplay === "full" ? (
        reply.activity.map((entry, index) =>
          entry.type === "step" ? (
            <ToolRow key={entry.step.id} step={entry.step} live={!!run} waiting={waiting} onPress={openActivity} />
          ) : (
            <MessageActions key={`text-${index}`} text={entry.text} markdown>
              {(openActions) => (
                <Markdown text={entry.text} media={savedMedia} basePath={basePath} selectable={selectableMessageText} onMessageAction={openActions} />
              )}
            </MessageActions>
          ),
        )
      ) : reply.activity.length === 1 && reply.activity[0]?.type === "step" ? (
        <ToolRow key={reply.activity[0].step.id} step={reply.activity[0].step} live={!!run} waiting={waiting} onPress={openActivity} />
      ) : (
        reply.activity.length > 0 && (
          <ActivityRow
            steps={reply.activity.flatMap((entry) => (entry.type === "step" ? [entry.step] : []))}
            live={!!run}
            waiting={waiting}
            onPress={openActivity}
          />
        )
      )}
      {reply.images.map((step) => (
        <View key={step.id} style={{ gap: 6 }}>
          <ToolRow step={step} live={!!run} waiting={waiting} onPress={openActivity} />
          <GeneratedImage step={step} media={savedMedia} />
        </View>
      ))}
      <ArtifactCards steps={reply.artifacts} chatId={chatId} chosen={designChoice} />
      {!!reply.answer.trim() && (
        <MessageActions text={reply.answer} markdown>
          {(openActions) => (
            <Markdown
              text={reply.answer}
              streaming={!!run}
              media={savedMedia}
              basePath={basePath}
              selectable={selectableMessageText}
              onMessageAction={openActions}
            />
          )}
        </MessageActions>
      )}
      {/* The reply says what the Heartbeat is for; its card follows. */}
      {heartbeats.map((step) => (
        <HeartbeatCard key={step.id} step={step} />
      ))}
      {!!thought && (
        <MessageActions text={thought} markdown>
          {(openActions) => (
            <View style={{ opacity: 0.75 }}>
              <Markdown text={thought} media={savedMedia} basePath={basePath} selectable={selectableMessageText} onMessageAction={openActions} />
            </View>
          )}
        </MessageActions>
      )}
      {!run && message?.outcome === "cancelled" && <Text style={styles.muted}>Turn stopped</Text>}
      {limit && message && <UsageLimitCard limit={limit} sessionId={message.session_id} projectPath={limitProjectPath} />}
      {!run && !limit && message?.outcome === "failed" && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          The turn failed. Review the response before trying again.
        </Text>
      )}
      {!run && !text && !allSteps.length && !message?.outcome && <Text style={styles.muted}>No text response</Text>}
    </View>
  );
});
