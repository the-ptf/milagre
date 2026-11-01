import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { CancelCircleIcon, CheckmarkCircle02Icon, Clock01Icon, HelpCircleIcon, Pulse01Icon, StopCircleIcon } from "@hugeicons/core-free-icons";
import type { ChatMessage } from "@milagre/shared/model";
import { directSubchats, latestReports, subchatSummary, type SubchatKind, type SubchatState, type SubchatSummary } from "@milagre/shared/subchat-states";
import { useDisplayNow } from "./display-clock";
import { radius, type } from "./design-tokens";
import { Icon, SpinnerRing, type IconData } from "./icons";
import { PillPanel, usePillPanel } from "./plan-pill";
import { useSession } from "./session";
import { STATUS_PILL, StatusPill } from "./status-pill";
import { useTheme } from "./theme";
import { useRoutines } from "./use-routines";
import { answerArguments, approvalArguments, inlineQuestion, isRecommended, KIND_TONE, pillSpoken, subchatStates } from "./subchat-view";

const NO_KEYS: string[] = [];

/** The Chat's Subchats pill state (the shared pill panel's), with the keys of the Chats its Delegations made. */
export function useSubchatPanel(sessions: Parameters<typeof directSubchats>[0], chatKey: string | undefined) {
  // The keys as one string, so a session changing under them (a title, a turn) leaves the pill and its panel as they are.
  const joined = (sessions && chatKey ? directSubchats(sessions, chatKey) : NO_KEYS).join("\n");
  const keys = useMemo(() => (joined ? joined.split("\n") : NO_KEYS), [joined]);
  const panel = usePillPanel(keys.length > 0, chatKey ?? "");
  return useMemo(() => ({ ...panel, keys, chatKey: chatKey ?? "" }), [panel, keys, chatKey]);
}

export type SubchatPanelState = ReturnType<typeof useSubchatPanel>;

/**
 * Every direct Subchat's state, live: the Project's sessions and runs, the Mac's Heartbeats and the reports in the open
 * Chat's transcript. The clock ticks by the second only while the panel is open (its rows show elapsed time).
 */
function useSubchats(panel: SubchatPanelState, messages: readonly ChatMessage[], live: boolean) {
  const session = useSession();
  const { routines, enabled } = useRoutines(session.client);
  const now = useDisplayNow(live ? 1000 : 60_000);
  const reports = useMemo(() => latestReports(messages), [messages]);
  const sessions = session.snapshot?.project.state.sessions;
  const runs = session.snapshot?.runs.runs;
  const { keys } = panel;
  return useMemo(
    () => subchatStates({ keys, sessions: sessions ?? {}, runs, routines, routinesOn: enabled === true, reports, now }),
    [keys, sessions, runs, routines, enabled, reports, now],
  );
}

/** The dot of a kind: a turning ring for live work, a still dot for the rest. */
function KindDot({ kind }: { kind: SubchatKind }) {
  const { colors } = useTheme();
  const tone = KIND_TONE[kind];
  if (tone === "accent") return <SpinnerRing size={10} stroke={1.5} color={colors.accent} />;
  return <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: tone === "ink3" ? colors.ink4 : colors[tone] }} />;
}

/** The pill's contents: the lead kind's dot, then the counts, the first in ink and the rest in ink-3. */
function SummaryContent({ summary }: { summary: SubchatSummary }) {
  const { colors } = useTheme();
  return (
    <>
      {summary.lead && <KindDot kind={summary.lead} />}
      <Text numberOfLines={1} style={{ fontSize: type.caption2, lineHeight: 14, fontVariant: ["tabular-nums"] }}>
        {summary.parts.map((part, index) => (
          <Text key={part.kind} style={{ color: index === 0 ? colors.ink : colors.ink3 }}>
            {index > 0 ? " · " : ""}
            {part.text}
          </Text>
        ))}
      </Text>
    </>
  );
}

/**
 * The Subchats pill above the composer: what the Chat's Subchats are doing in a few words ("1 needs you · 2 working"),
 * led by the dot of the most urgent. A tap grows it into the list. Hidden without a Subchat.
 */
export const SubchatPill = memo(function SubchatPill({ panel, messages }: { panel: SubchatPanelState; messages: readonly ChatMessage[] }) {
  const { phase, show, close, attachChip, relayout } = panel;
  const states = useSubchats(panel, messages, false);
  // The row gives way to a question card: the panel folds away with it rather than covering the question.
  useEffect(() => close, [close]);
  if (!states.length) return null;
  const summary = subchatSummary(states);
  // While the surface is out, it is the pill: this one keeps its place in the row, invisible.
  const away = phase !== "closed";
  return (
    <StatusPill
      chipRef={attachChip}
      leading={<SummaryContent summary={summary} />}
      accessibilityLabel={pillSpoken(summary)}
      accessibilityHint="Opens the list of Subchats"
      expanded={away}
      hidden={away}
      onPress={show}
      // New counts resize the pill; an open panel keeps growing from its new frame.
      onLayout={relayout}
    />
  );
});

const STATUS_ICONS: Record<Exclude<SubchatKind, "working">, IconData> = {
  "needs-you": HelpCircleIcon,
  failed: CancelCircleIcon,
  holding: Pulse01Icon,
  queued: Clock01Icon,
  stopped: StopCircleIcon,
  done: CheckmarkCircle02Icon,
};

function StatusMark({ kind }: { kind: SubchatKind }) {
  const { colors } = useTheme();
  const tone = KIND_TONE[kind];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}
    >
      {kind === "working" ? (
        <SpinnerRing size={16} stroke={2} color={colors.accent} />
      ) : (
        <Icon icon={STATUS_ICONS[kind]} color={tone === "ink3" ? colors.ink3 : colors[tone]} size={18} strokeWidth={2} />
      )}
    </View>
  );
}

/** A small answer button: 32 tall with a hit area of 44, the recommended option filled in ink. */
function AnswerButton({ title, primary = false, disabled, onPress }: { title: string; primary?: boolean; disabled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      style={({ pressed }) => ({
        minHeight: 32,
        maxWidth: "100%",
        paddingHorizontal: 12,
        borderRadius: radius.control,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: primary ? colors.ink : colors.surface,
        borderWidth: primary ? 0 : 1,
        borderColor: colors.lineStrong,
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      <Text numberOfLines={1} style={{ color: primary ? colors.onInk : colors.ink, fontSize: type.footnote, fontWeight: "600" }}>
        {title}
      </Text>
    </Pressable>
  );
}

function SubchatRow({
  state,
  sending,
  error,
  onOpen,
  onAnswer,
  onDecide,
}: {
  state: SubchatState;
  sending: boolean;
  error: string | undefined;
  onOpen: () => void;
  onAnswer: (label: string) => void;
  onDecide: (decision: "allow" | "deny") => void;
}) {
  const { colors } = useTheme();
  const needsYou = state.kind === "needs-you";
  const inline = inlineQuestion(state.request);
  const detailInk = state.kind === "failed" ? colors.redInk : state.kind === "done" ? colors.ink2 : colors.ink3;
  const labelInk = needsYou ? colors.orangeInk : state.kind === "failed" ? colors.redInk : colors.ink3;
  const request = state.request;
  return (
    <View style={{ borderRadius: radius.control, borderCurve: "continuous", backgroundColor: needsYou ? colors.orangeTint : undefined }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${state.title}, ${state.label}${state.elapsed ? `, ${state.elapsed}` : ""}. ${state.detail}`}
        accessibilityHint="Opens this Subchat"
        onPress={onOpen}
        style={({ pressed }) => ({
          minHeight: 56,
          paddingHorizontal: 12,
          paddingVertical: 10,
          gap: 2,
          borderRadius: radius.control,
          borderCurve: "continuous",
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StatusMark kind={state.kind} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: type.subheadline, fontWeight: "600" }}>
            {state.title}
          </Text>
          <Text numberOfLines={1} style={{ color: labelInk, fontSize: type.footnote, fontVariant: ["tabular-nums"] }}>
            {state.label}
            {state.elapsed ? ` · ${state.elapsed}` : ""}
          </Text>
        </View>
        <Text numberOfLines={state.kind === "done" ? 2 : 1} style={{ marginLeft: 28, color: detailInk, fontSize: type.footnote }}>
          {state.detail}
        </Text>
      </Pressable>
      {needsYou && request && (
        <View style={{ paddingLeft: 40, paddingRight: 12, paddingBottom: 12, gap: 8 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {request.kind === "approval" ? (
              <>
                <AnswerButton title="Allow" primary disabled={sending} onPress={() => onDecide("allow")} />
                <AnswerButton title="Deny" disabled={sending} onPress={() => onDecide("deny")} />
              </>
            ) : (
              <>
                {inline?.options.map((label) => (
                  <AnswerButton key={label} title={label} primary={isRecommended(label)} disabled={sending} onPress={() => onAnswer(label)} />
                ))}
                <AnswerButton title="Reply…" disabled={sending} onPress={onOpen} />
              </>
            )}
          </View>
          {!!error && (
            <Text accessibilityRole="alert" style={{ color: colors.redInk, fontSize: type.footnote }}>
              {error}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * The Subchats panel: the pill grown over the Chat, one row per Subchat with what it is doing, and the answer to what
 * needs the user a tap away (a single-choice question's options, an approval's Allow and Deny). A row opens its Subchat.
 * Render it once, over the transcript and the composer.
 */
export function SubchatPanel({
  panel,
  messages,
  onOpenChat,
}: {
  panel: SubchatPanelState;
  messages: readonly ChatMessage[];
  onOpenChat: (chatKey: string) => void;
}) {
  const session = useSession();
  const states = useSubchats(panel, messages, panel.phase !== "closed");
  const [sent, setSent] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ requestId: string; message: string } | null>(null);
  if (!states.length) return null;
  const summary = subchatSummary(states);
  const client = session.client;
  const open = (key: string) => {
    panel.close();
    onOpenChat(key);
  };
  // One call at a time: the row says nothing is left to press until the host's answer arrives or fails.
  const send = async (requestId: string, call: () => Promise<unknown>, refused: string) => {
    if (!client) return;
    setSent(requestId);
    setFailure(null);
    try {
      if (!(await call())) throw new Error(refused);
    } catch (error) {
      setSent((current) => (current === requestId ? null : current));
      setFailure({ requestId, message: error instanceof Error ? error.message : refused });
    }
  };
  return (
    <PillPanel
      panel={panel}
      name="Subchats"
      testId="subchats"
      title="Subchats"
      count={states.length}
      face={
        <View
          style={{
            height: STATUS_PILL.height,
            paddingHorizontal: STATUS_PILL.paddingHorizontal + 1,
            flexDirection: "row",
            alignItems: "center",
            gap: STATUS_PILL.gap,
          }}
        >
          <SummaryContent summary={summary} />
        </View>
      }
    >
      <View style={{ gap: 4 }}>
        {states.map((state) => {
          const request = state.request;
          const requestId = request?.kind === "approval" ? request.request.requestId : request?.requestId;
          const inline = inlineQuestion(request);
          return (
            <SubchatRow
              key={state.key}
              state={state}
              sending={!!requestId && sent === requestId}
              error={failure && failure.requestId === requestId ? failure.message : undefined}
              onOpen={() => open(state.key)}
              onAnswer={(label) => {
                if (request?.kind !== "question" || !inline) return;
                const args = answerArguments(state.key, request, inline.question, label);
                void send(args.requestId, () => client!.call("agent:answer-question", [args]), "This question is no longer pending.");
              }}
              onDecide={(decision) => {
                if (request?.kind !== "approval") return;
                const args = approvalArguments(state.key, request, decision);
                void send(args.requestId, () => client!.call("agent:respond-permission", [args]), "This approval is no longer pending.");
              }}
            />
          );
        })}
      </View>
    </PillPanel>
  );
}
