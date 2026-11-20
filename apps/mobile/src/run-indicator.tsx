import { useMemo } from "react";
import { router } from "expo-router";
import { sessionIdFromKey } from "@milagre/shared/agent-runs";
import { Text, View } from "react-native";
import { loaderActivity } from "@milagre/shared/reply-parts";
import { currentActivityStep, stepDisplayTitle, waitingStepIds } from "@milagre/shared/tool-activity";
import { ActivityTitle } from "./activity-item";
import { useToolCallDisplay } from "./chat-display-setting";
import { lineHeight, radius, type } from "./design-tokens";
import { ThinkingIndicator } from "./running-logo";
import { useRun } from "./session";
import { useTheme } from "./theme";

export function RunIndicator({ chatKey, startedAt, phase, model }: { chatKey: string; startedAt?: number; phase?: string | null; model: string }) {
  const { colors } = useTheme();
  const run = useRun(chatKey);
  const label = phase ?? (run?.waitingForSubagents ? "Waiting on subagents" : `Working with ${model}`);
  const showLabel = Boolean(phase);
  const since = startedAt ?? run?.startedAt;
  const onPress = () => router.push({ pathname: "/activity", params: { id: String(sessionIdFromKey(chatKey)), message: "run" } });
  const [toolCallDisplay] = useToolCallDisplay();
  const steps = useMemo(
    () => (run && !run.questions.length && toolCallDisplay !== "full" ? loaderActivity(run.text, run.steps, waitingStepIds(run.approvals)) : []),
    [run, toolCallDisplay],
  );
  if (!steps.length || showLabel) return <ThinkingIndicator label={label} showLabel={showLabel} startedAt={since} />;
  const running = steps.filter((step) => step.status === "running").length;
  const current = currentActivityStep(steps) ?? steps.at(-1);
  const title =
    running > 1
      ? `Running ${running} calls`
      : current
        ? stepDisplayTitle({ ...current, description: undefined, detail: undefined }, current.status === "running")
        : label;
  const caption = { color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 };
  const dot = <View style={{ width: 3, height: 3, borderRadius: radius.full, backgroundColor: colors.ink4 }} />;
  return (
    <ThinkingIndicator
      label={`${title.replace(/`/g, "")}, ${steps.length === 1 ? "1 call" : `${steps.length} calls`}`}
      startedAt={since}
      onPress={onPress}
      detail={
        <>
          <View style={{ flexShrink: 1 }}>
            <ActivityTitle
              key={current?.id}
              title={title}
              shimmer={running > 0}
              style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}
            />
          </View>
          {running < steps.length || running < 2 ? (
            <>
              {dot}
              <Text style={caption}>{steps.length === 1 ? "1 call" : `${steps.length} calls`}</Text>
            </>
          ) : null}
          {dot}
        </>
      }
    />
  );
}
