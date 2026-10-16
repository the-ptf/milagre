import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, Text, View, type ImageSourcePropType } from "react-native";
import Svg, { Path } from "react-native-svg";
import { router } from "expo-router";
import { Alert02Icon, ArrowRight01Icon, Maximize01Icon } from "@hugeicons/core-free-icons";
import type { AgentRun } from "@milagre/shared/agent-runs";
import type { ChatMessage, ChatStep } from "@milagre/shared/model";
import { activitySummary, replyActivity, unspokenThought } from "@milagre/shared/reply-parts";
import { FileChip } from "./file-chip";
import { Markdown } from "./markdown";
import { Icon } from "./icons";
import { ActivityTitle } from "./activity-item";
import { ToolRow } from "./tool-row";
import { ArtifactCards, DesignFeedbackCard } from "./artifact";
import { advisorResultLabel } from "@milagre/shared/advisor-result";
import { parseDesignFeedback } from "@milagre/shared/artifact";
import { AnswerCard } from "./answer-card";
import { useToolCallDisplay } from "./chat-display-setting";
import { PullRequestActionCard } from "./pr-action-card";
import { isPullRequestAction } from "@milagre/shared/pr-action";
import { isLinearIssueContext } from "@milagre/shared/linear-issue";
import { LinearIssueCard } from "./linear-issue-card";
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
function open(images: ViewerImage[], index: number, thumbs: (View | null)[]) {
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

/** Your photos above your bubble: one large, or tiles; tapping opens the full-screen viewer. */
function Photos({ message, media }: { message: ChatMessage; media: MediaSource }) {
  const photos: ViewerImage[] = (message.images || []).map((photo) => ({
    name: photo.name,
    source: photo.dataUrl ? { uri: photo.dataUrl } : photo.path ? media(photo.path) : { uri: "" },
  }));
  const thumbs = useRef<(View | null)[]>([]);
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
/** An image the agent generated, under its step, at most 240 wide; tap or expand for full screen. */
function GeneratedImage({ step, media }: { step: ChatStep; media: MediaSource }) {
  const { colors } = useTheme();
  const [ratio, setRatio] = useState(4 / 5);
  const thumb = useRef<View>(null);
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
      <View
        style={{
          position: "absolute",
          right: 8,
          top: 8,
          width: 30,
          height: 30,
          borderRadius: 10,
          backgroundColor: "#ffffffcc",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon icon={Maximize01Icon} tone="ink" size={15} />
      </View>
    </Pressable>
  );
}
const SPARKLE = "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z";
/** Desktop's ActivityBlock header: a sparkle, the running step's shimmering title or the summary, and failures. */
function ActivityRow({ steps, live, waiting, onPress }: { steps: ChatStep[]; live: boolean; waiting: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const current = live ? [...steps].reverse().find((step) => step.status === "running") : undefined;
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
          <ActivityTitle title={current.title} shimmer={!waiting} style={{ color: colors.ink2, fontSize: 14 }} />
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
}: {
  message?: ChatMessage;
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
  const { colors } = useTheme();
  const styles = useStyles();
  const [toolCallDisplay] = useToolCallDisplay();
  const savedMedia = useCallback((path: string) => media(message?.images?.find((image) => image.sourcePath === path)?.path || path), [media, message?.images]);
  const openActivity = () => onActivity(message ? String(message.id) : "run");
  const text = run?.text ?? message?.body ?? "";
  const steps = run?.steps ?? message?.steps ?? [];
  const reply = replyActivity(text, steps);
  const waiting = !!(run?.approvals.length || run?.questions.length);
  // Feedback sent from the design sheet or canvas shows as a card, not as the text the agent reads.
  const feedback = message?.role === "user" ? parseDesignFeedback(text) : null;
  // So does a PR-blocker pill's action, instead of the skill prompt the agent read.
  const prAction = message?.role === "user" && isPullRequestAction(message.context) ? message.context : null;
  // And a Chat's first message when it was started from a Linear issue.
  const issue = message?.role === "user" && isLinearIssueContext(message.context) ? message.context : null;
  // What the agent concluded only in thinking, once the turn ends or stops on a question.
  const thought = !run || run.questions.length ? unspokenThought(text, steps) : "";
  const limit = !run && message?.role === "assistant" ? usageLimitOf(message) : null;
  const advisor = typeof message?.context === "object" && message.context?.kind === "advisor-result" ? message.context : null;
  if (advisor)
    return (
      <View style={{ gap: 6, paddingVertical: 8 }}>
        <Text style={styles.caption}>{advisorResultLabel(advisor)}</Text>
        <Markdown text={text} />
      </View>
    );
  if (message?.role === "user")
    return (
      <View style={{ alignSelf: "flex-end", alignItems: "flex-end", gap: 6, maxWidth: "88%" }}>
        <Photos message={message} media={media} />
        {message.files
          ?.filter((file) => !message.images?.some((image) => image.path === file || image.sourcePath === file))
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
          !!text && (
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
              <Text selectable style={{ color: colors.ink, fontSize: 15, lineHeight: 22 }}>
                {text}
              </Text>
            </View>
          )
        )}
      </View>
    );
  return (
    <View style={{ gap: 14, paddingVertical: 8 }}>
      {reply.setup.map((step) => (
        <ToolRow key={step.id} step={step} live={!!run} waiting={waiting} onPress={openActivity} />
      ))}
      {/* Full detail (Settings › Chat › Tool call display): every tool call is its own row, with the notes between them. */}
      {toolCallDisplay === "full" ? (
        reply.activity.map((entry, index) =>
          entry.type === "step" ? (
            <ToolRow key={entry.step.id} step={entry.step} live={!!run} waiting={waiting} onPress={openActivity} />
          ) : (
            <Markdown key={`text-${index}`} text={entry.text} media={savedMedia} basePath={basePath} />
          ),
        )
      ) : reply.activity.length === 1 && reply.activity[0].type === "step" ? (
        <ToolRow step={reply.activity[0].step} live={!!run} waiting={waiting} onPress={openActivity} />
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
      {!!reply.answer.trim() && <Markdown text={reply.answer} streaming={!!run} media={savedMedia} basePath={basePath} />}
      {!!thought && (
        <View style={{ opacity: 0.75 }}>
          <Markdown text={thought} media={savedMedia} basePath={basePath} />
        </View>
      )}
      {!run && message?.outcome === "cancelled" && <Text style={styles.muted}>Turn stopped</Text>}
      {limit && message && <UsageLimitCard limit={limit} sessionId={message.session_id} projectPath={limitProjectPath} />}
      {!run && !limit && message?.outcome === "failed" && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          The turn failed. Review the response before trying again.
        </Text>
      )}
      {!run && !text && !steps.length && !message?.outcome && <Text style={styles.muted}>No text response</Text>}
    </View>
  );
});
