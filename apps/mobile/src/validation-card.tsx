import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  DashedLineCircleIcon,
  HistoryIcon,
  MinusSignIcon,
  PlayIcon,
  RefreshIcon,
  StopCircleIcon,
  StopIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  VALIDATION_RESULT_WORDS,
  formatValidationDuration,
  validationExit,
  validationFixPrompt,
  validationMeta,
  validationStaleText,
  validationTitle,
  type ValidationContext,
  type ValidationResult,
} from "@milagre/shared/validation";
export { isValidation } from "@milagre/shared/validation";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon, SpinnerRing, type IconData } from "./icons";
import { fonts, useTheme } from "./theme";
import { PillButton } from "./ui";
import { PRESSED_OPACITY } from "./primitives/press-style";

type Call = <T>(method: string, args: unknown[]) => Promise<T>;
type Look = { icon: IconData; tone: "green" | "red" | "ink3" | "ink4" };

const RUN_LOOKS: Record<string, Look> = {
  passed: { icon: CheckmarkCircle02Icon, tone: "green" },
  failed: { icon: CancelCircleIcon, tone: "red" },
  "not-run": { icon: DashedLineCircleIcon, tone: "ink4" },
  interrupted: { icon: StopCircleIcon, tone: "ink3" },
};
const RESULT_LOOKS: Record<string, Look> = {
  passed: { icon: Tick02Icon, tone: "green" },
  failed: { icon: Cancel01Icon, tone: "red" },
  interrupted: { icon: StopIcon, tone: "ink3" },
};

function Mark({ status, run }: { status: string; run?: boolean }) {
  const size = run ? 20 : 16;
  if (status === "running") return <SpinnerRing size={size} />;
  const look = (run ? RUN_LOOKS : RESULT_LOOKS)[status] ?? { icon: MinusSignIcon, tone: "ink4" };
  return <Icon icon={look.icon} size={size} tone={look.tone} />;
}

function Row({
  result,
  open,
  log,
  onPress,
  onFullLog,
}: {
  result: ValidationResult;
  open: boolean;
  log?: string;
  onPress: () => void;
  onFullLog?: () => void;
}) {
  const { colors } = useTheme();
  const output = log ?? result.tail;
  const openable = Boolean(output || result.reason);
  const exit = validationExit(result);
  const took = result.durationMs !== undefined ? formatValidationDuration(result.durationMs) : "";
  return (
    <View style={{ borderTopWidth: 1, borderColor: colors.line, backgroundColor: open ? colors.inset : undefined }}>
      <Pressable
        disabled={!openable}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${result.name}: ${VALIDATION_RESULT_WORDS[result.status]}${exit ? `, ${exit}` : ""}`}
        accessibilityState={openable ? { expanded: open } : undefined}
        style={({ pressed }) => ({
          minHeight: 52,
          paddingHorizontal: space.xl,
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          opacity: pressed ? PRESSED_OPACITY : 1,
        })}
      >
        <Mark status={result.status} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500", color: colors.ink }}>
            {result.name}
          </Text>
          <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: type.caption1, lineHeight: lineHeight.caption1, color: colors.ink3 }}>
            {result.command}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          {exit ? <Text style={{ fontSize: type.caption1, lineHeight: lineHeight.caption1, color: colors.ink3 }}>{exit}</Text> : null}
          {took ? <Text style={{ fontSize: type.caption1, lineHeight: lineHeight.caption1, color: colors.ink3 }}>{took}</Text> : null}
        </View>
      </Pressable>
      {open && (
        <View style={{ paddingLeft: space.xl + 16 + space.md, paddingRight: space.xl, paddingBottom: space.lg, gap: space.xs }}>
          {result.cwd ? <Text style={{ fontFamily: fonts.mono, fontSize: type.caption2, color: colors.ink3 }}>in {result.cwd}</Text> : null}
          {result.reason ? <Text style={{ fontSize: type.footnote, lineHeight: lineHeight.footnote, color: colors.ink2 }}>{result.reason}</Text> : null}
          {output ? (
            <Text selectable style={{ fontFamily: fonts.mono, fontSize: type.caption2, lineHeight: lineHeight.caption1, color: colors.ink2 }}>
              {output}
            </Text>
          ) : null}
          {result.hasLog && log === undefined && onFullLog ? <PillButton size="small" variant="plain" title="Open full log" onPress={onFullLog} /> : null}
        </View>
      )}
    </View>
  );
}

/** A validation run Milagre recorded in the Chat, as on desktop: what each command returned, never what the agent said. */
export function ValidationCard({
  context,
  chatId,
  call,
  onAskToFix,
}: {
  context: ValidationContext;
  chatId: string | null;
  call?: Call;
  onAskToFix?: (text: string) => void;
}) {
  const { colors } = useTheme();
  const [opened, setOpened] = useState<number | null>(null);
  const [logs, setLogs] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const firstFailure = context.results.findIndex((result) => result.status === "failed");
  const openIndex = opened ?? (firstFailure >= 0 ? firstFailure : null);
  const live = chatId && call ? { chatId, call } : null;
  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    work()
      .catch((failure) => setError(failure instanceof Error ? failure.message : "Something went wrong."))
      .finally(() => setBusy(false));
  };
  const run = live && (() => act(() => live.call("validation:run", [{ chatId: live.chatId }])));
  const stop = live && (() => act(() => live.call("validation:stop", [{ chatId: live.chatId, runId: context.runId }])));
  const fullLog = (index: number) =>
    live
      ? () =>
          act(async () => {
            const { text } = await live.call<{ text: string }>("validation:log", [{ chatId: live.chatId, runId: context.runId, index }]);
            setLogs((held) => ({ ...held, [index]: text }));
          })
      : undefined;
  const actions =
    context.status === "running" ? (
      stop && <PillButton size="small" variant="secondary" destructive title="Stop" disabled={busy} onPress={stop} />
    ) : context.status === "not-run" ? (
      run && <PillButton size="small" icon={PlayIcon} title="Run validation" disabled={busy} onPress={run} />
    ) : (
      <>
        {run && <PillButton size="small" variant="secondary" icon={RefreshIcon} title="Run again" disabled={busy} onPress={run} />}
        {context.status === "failed" && onAskToFix && live && (
          <PillButton size="small" variant="secondary" title="Ask to fix" onPress={() => onAskToFix(validationFixPrompt(context))} />
        )}
      </>
    );
  return (
    <View
      testID="validation-card"
      style={{
        width: "100%",
        borderRadius: radius.card,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
        boxShadow: colors.shadowCard,
        overflow: "hidden",
      }}
    >
      <View
        style={{ flexDirection: "row", gap: space.md, alignItems: "flex-start", paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.md }}
      >
        <Mark status={context.status} run />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600", color: colors.ink }}>
            {validationTitle(context)}
          </Text>
          <Text style={{ fontSize: type.footnote, lineHeight: lineHeight.footnote, color: colors.ink3 }}>{validationMeta(context)}</Text>
        </View>
      </View>
      {context.stale ? (
        <View
          style={{
            marginHorizontal: space.xl,
            marginBottom: space.lg,
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            borderRadius: radius.control,
            borderCurve: "continuous",
            backgroundColor: colors.field,
            flexDirection: "row",
            gap: space.sm,
          }}
        >
          <Icon icon={HistoryIcon} size={16} tone="ink2" />
          <Text style={{ flex: 1, fontSize: type.footnote, lineHeight: lineHeight.footnote, color: colors.ink2 }}>{validationStaleText(context.stale)}</Text>
        </View>
      ) : null}
      {error ? <Text style={{ marginHorizontal: space.xl, marginBottom: space.md, fontSize: type.footnote, color: colors.redInk }}>{error}</Text> : null}
      {context.results.map((result, index) => (
        <Row
          key={`${result.name}-${index}`}
          result={result}
          open={openIndex === index}
          log={logs[index]}
          onPress={() => setOpened(openIndex === index ? -1 : index)}
          onFullLog={fullLog(index)}
        />
      ))}
      {actions ? (
        <View
          style={{ flexDirection: "row", gap: space.md, paddingHorizontal: space.xl, paddingVertical: space.lg, borderTopWidth: 1, borderColor: colors.line }}
        >
          {actions}
        </View>
      ) : null}
    </View>
  );
}
