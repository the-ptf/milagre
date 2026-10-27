import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { activitySummary, replyActivity } from "@milagre/shared/reply-parts";
import type { ChatStep } from "@milagre/shared/model";
import { waitingStepIds } from "@milagre/shared/tool-activity";
import { ToolRow } from "../tool-row";
import { Markdown } from "../markdown";
import { useSession } from "../session";
import { CircleButton, PageScroll, PillButton, useStyles } from "../ui";
import { Approval } from "../questions";
import { useChatPage } from "../chat-pages";
import { useTheme } from "../theme";

/** A reply's tools and notes, like desktop's expanded ActivityBlock; live while the turn runs. Each tool expands to its output. */
export default function ActivitySheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const { id, message, stepId } = useLocalSearchParams<{ id: string; message: string; stepId?: string }>();
  const session = useSession();
  const project = session.snapshot?.project;
  const chatId = `${project?.path}#${id}`;
  const run = message === "run" ? session.snapshot?.runs.runs[chatId] : undefined;
  // A host that keeps messages by Chat sends the snapshot without them: the sheet reads its Chat's as a page.
  const page = useChatPage(project?.state.messagesInChats ? session.client : null, project?.path, Number(id), session.snapshot, session.reconnects);
  const chatMessages = project?.state.messagesInChats ? page.messages : (project?.state.messages ?? []);
  // When the live turn ends while the sheet is open, its saved reply takes over.
  const saved =
    message === "run"
      ? run
        ? undefined
        : chatMessages.findLast((entry) => entry.session_id === Number(id) && entry.role !== "user")
      : chatMessages.find((entry) => entry.id === Number(message));
  // The snapshot leaves tool output out; the sheet fetches this message whole so each tool can expand.
  const [full, setFull] = useState<{ id: number; steps: ChatStep[]; body: string } | null>(null);
  const [readFailure, setReadFailure] = useState<{ id: number; attempt: number; connection?: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState("");
  // A reply before the page held here is read by id.
  const outside = !saved && message !== "run" && !!project?.state.messagesInChats && !page.loading;
  const client = session.client,
    projectPath = project?.path,
    savedId = saved?.id ?? (outside ? Number(message) : undefined),
    slim = outside || !!saved?.steps?.some((step) => step.hasDetail);
  const outputPending = slim && full?.id !== savedId;
  const readError = outputPending && readFailure?.id === savedId && readFailure?.attempt === retry && readFailure?.connection === session.reconnects;
  useEffect(() => {
    if (!client || !projectPath || savedId === undefined || !slim) return;
    let cancelled = false;
    void client
      .message(projectPath, savedId)
      .then((whole) => {
        if (!cancelled) setFull({ id: savedId, steps: whole.steps ?? [], body: whole.body });
      })
      .catch(() => {
        if (!cancelled) setReadFailure({ id: savedId, attempt: retry, connection: session.reconnects });
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectPath, savedId, slim, retry, session.reconnects]);
  const steps = run?.steps ?? (full && full.id === savedId ? full.steps : saved?.steps) ?? [];
  const { setup, activity, images } = replyActivity(run?.text ?? saved?.body ?? (full && full.id === savedId ? full.body : "") ?? "", steps);
  const waiting = waitingStepIds(run?.approvals);
  const summary = activitySummary(steps);
  const selected = stepId ? steps.find((step) => step.id === stepId) : undefined;
  const renderStep = (step: ChatStep, expanded = false) => {
    const approval = run?.approvals.find((request) => request.stepId === step.id);
    return (
      <View key={step.id}>
        <ToolRow step={step} live={!!run} waiting={waiting.includes(step.id)} expanded={expanded} />
        {approval && (
          <Approval
            approval={approval}
            busy={answering}
            respond={(decision) => {
              if (!client || answering) return;
              setAnswering(true);
              setAnswerError("");
              void client
                .call("agent:respond-permission", [{ chatId, requestId: approval.requestId, decision }])
                .then(
                  (accepted) => {
                    if (!accepted) setAnswerError("This approval is no longer pending.");
                  },
                  () => setAnswerError("Could not send approval. Try again."),
                )
                .finally(() => setAnswering(false));
            }}
          />
        )}
      </View>
    );
  };
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0, paddingBottom: 40, flexGrow: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
        <CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />
        <View style={{ alignItems: "center", flexShrink: 1 }}>
          <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
            {selected ? "Tool call" : "Activity"}
          </Text>
          {!selected && !!summary.text && (
            <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 12 }}>
              {run ? "Running" : summary.text}
            </Text>
          )}
        </View>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
        {outputPending && (
          <Text accessibilityRole="status" style={styles.muted}>
            {readError ? "Could not load tool output." : "Loading output..."}
          </Text>
        )}
        {readError && <PillButton title="Try again" secondary onPress={() => setRetry((value) => value + 1)} />}
        {!steps.length && <Text style={styles.muted}>No activity yet.</Text>}
        {selected ? (
          renderStep(selected, true)
        ) : (
          <>
            {setup.map((step) => renderStep(step))}
            {activity.map((entry, index) =>
              entry.type === "step" ? (
                renderStep(entry.step)
              ) : (
                <View key={`text-${index}`} style={{ paddingVertical: 6 }}>
                  <Markdown text={entry.text} />
                </View>
              ),
            )}
            {images.map((step) => renderStep(step))}
          </>
        )}
        {!!answerError && (
          <Text accessibilityRole="alert" style={{ color: colors.red }}>
            {answerError}
          </Text>
        )}
      </View>
    </PageScroll>
  );
}
