import { useState, type ReactNode } from "react";
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import {
  AlarmClockOffIcon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Invoice01Icon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  StopCircleIcon,
  TestTube01Icon,
} from "@hugeicons/core-free-icons";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { currentStep, findStep, flowRunText, runRows, stepTitle, type FlowRunRow } from "@milagre/shared/routine-flows";
import { canRunNow, clock, dayLabel, runDuration } from "@milagre/shared/routines";
import type { FlowApproval, FlowReceipt, FlowStep, FlowStepRun, RoutineRun } from "@milagre/shared/model";
import { useSession } from "../session";
import { useRoutines, type RoutineWithRuns } from "../use-routines";
import { useFlowDraft } from "../flow-draft";
import { openStep } from "../flow-editor";
import { startTestRun } from "../flow-routine";
import { flowRunState, flowRunTitle, outputChips, runName, stepRunLine, stepStateLook, triggerRunLine, triggerTitle } from "../flow-looks";
import { useActivityClock } from "../chat-row-store";
import { confirm } from "../confirm-store";
import { Icon, SpinnerRing } from "../icons";
import { lineHeight, radius, space, type } from "../design-tokens";
import { ErrorNotice, Field, HeaderButton, InlineError, PageScroll, PillButton, Tag, pressStyle, showActions, tap, useStyles } from "../ui";
import { useTheme } from "../theme";

/** Sends a flow action for the Run: approve, reject, pause, resume, end or retry. */
type Act = (action: string, options?: { reason?: string; note?: string }, fallback?: string) => Promise<boolean>;
const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const firstLine = (text: string | undefined) =>
  text
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim() ?? "";

/** "10:02" today, "Mon 16:20" before. */
function when(at: number, now: number) {
  const day = dayLabel(at, now);
  return day === "Today" ? clock(at) : `${day} ${clock(at)}`;
}

/**
 * One flow Run, step by step, as desktop's Run view on a phone: its state, its issue, when and where it started on which
 * revision, then a timeline of its steps with what each did. An approval waiting on you sits inline with Approve and Reject
 * (Reject asks for a reason); a pull request it opened shows its receipt; a step that failed shows its error and tries,
 * with Retry with a note. Pause Run is under the title; End Run is in the menu, behind a confirmation.
 */
export default function FlowRunScreen() {
  const params = useLocalSearchParams<{ id: string; run: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSession();
  const { client } = session;
  const routines = useRoutines(client);
  const routine = routines.routines.find((item) => item.id === params.id);
  const run = routine?.runs?.find((item) => item.id === params.run);
  const draft = useFlowDraft(client, routine, routines.update);
  const now = useActivityClock(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  if (!routine || !run || !client || !run.flow)
    return (
      <>
        <Stack.Screen options={{ title: "Run" }} />
        <PageScroll>
          {routines.error ? <ErrorNotice message={routines.error} retry={() => void routines.refresh()} retryTitle="Reload" /> : null}
          <Text style={styles.muted}>
            {!client ? "Connect to your computer to see this Run." : routines.loading ? "Loading…" : "This Run is no longer on your computer."}
          </Text>
        </PageScroll>
      </>
    );

  const flow = run.flow;
  const state = flowRunState(run);
  const name = runName(routine, run);
  const active = state === "running" || state === "waiting" || state === "you";

  async function act(action: string, options: { reason?: string; note?: string } = {}, fallback = "Could not change this Run.") {
    if (!client || !routine || !run || busy) return false;
    setError("");
    setBusy(action);
    try {
      await client.call("routines:flow-act", [routine.id, run.id, action, options]);
      await routines.refresh();
      return true;
    } catch (caught) {
      setError(failure(caught, fallback));
      return false;
    } finally {
      setBusy("");
    }
  }
  async function end() {
    if (!(await confirm(`End ${name}?`, "The step under way stops and no later step runs. Nothing it already did is undone.", "End Run"))) return;
    await act("end", {}, "Could not end this Run.");
  }
  const openChat = (key: string) =>
    router.push({ pathname: "/chat", params: { projectPath: projectOfKey(key), hostId: client.url, id: String(sessionIdFromKey(key)) } });
  const menu = () =>
    showActions({
      title: name,
      actions: [
        ...(active ? [{ id: "pause", title: "Pause Run" }] : []),
        ...(state === "paused" ? [{ id: "resume", title: "Resume Run" }] : []),
        ...(run.chatId ? [{ id: "chat", title: "Open Chat" }] : []),
        ...(active || state === "paused" || state === "failed" ? [{ id: "end", title: "End Run", destructive: true }] : []),
      ],
      onSelect: (id) => {
        if (id === "pause" || id === "resume") void act(id);
        else if (id === "chat" && run.chatId) openChat(run.chatId);
        else if (id === "end") void end();
      },
    });
  async function runAgain() {
    if (!client || !routine || busy) return;
    setError("");
    setBusy("again");
    try {
      if (canRunNow(routine) && routine.enabled) {
        await client.call("routines:run-now", [routine.id]);
        await routines.refresh();
        router.back();
      } else await startTestRun(client, routine.id, draft.flush, routines.refresh);
    } catch (caught) {
      setError(failure(caught, "Could not start a Run."));
    } finally {
      setBusy("");
    }
  }

  const chip =
    state === "you" ? (
      <Tag label="Waiting for you" tone="orange" dot />
    ) : state === "failed" ? (
      <Tag label={flowRunText(run)} tone="red" />
    ) : state === "done" ? (
      <Tag label={flowRunText(run)} tone="green" icon={CheckmarkCircle02Icon} />
    ) : state === "ended" ? (
      <Tag label={flowRunText(run)} icon={/expired/i.test(run.error ?? "") ? AlarmClockOffIcon : StopCircleIcon} />
    ) : state === "running" ? (
      <Tag label={flowRunText(run)} tone="accent" dot />
    ) : (
      <Tag label={flowRunText(run)} dot />
    );
  const rows = runRows(flow);
  // The step an approval expired or was rejected at: its time limit can be changed in the draft.
  const askStep = state === "ended" ? rows.find((row) => row.kind === "step" && row.run?.approval?.decision === "expired") : undefined;
  const askStepId = askStep?.kind === "step" && findStep(draft.steps, askStep.step.id) ? askStep.step.id : "";
  const again = canRunNow(routine) && routine.enabled;
  const stopped = currentStep(flow);

  return (
    <>
      <Stack.Screen options={{ title: name }} />
      <Stack.Toolbar placement="right">
        {Platform.OS === "ios" ? (
          <Stack.Toolbar.Button icon="ellipsis" accessibilityLabel="More" onPress={menu} />
        ) : (
          <Stack.Toolbar.View>
            <HeaderButton label="More" icon={MoreHorizontalIcon} onPress={menu} />
          </Stack.Toolbar.View>
        )}
      </Stack.Toolbar>
      <PageScroll style={{ flex: 1 }} contentContainerStyle={{ gap: space.xl }}>
        {routines.error ? <ErrorNotice message={routines.error} retry={() => void routines.refresh()} retryTitle="Reload" /> : null}
        {error ? <ErrorNotice message={error} /> : null}
        <View style={{ gap: space.md }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {chip}
            {flow.dryRun ? <Tag label="Test run" icon={TestTube01Icon} /> : null}
          </View>
          <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type.title2, lineHeight: lineHeight.title2, fontWeight: "600" }}>
            {flowRunTitle(run, routine.name)}
          </Text>
          <Text style={styles.footnote}>
            {`Started ${when(run.startedAt, now)} on ${session.hostName || "your computer"}, ${routine.name} revision ${flow.revision || 1}`}
          </Text>
          {flow.dryRun ? <Text style={styles.footnote}>Simulation: agents use sample or saved fields. Actions and waits do not run.</Text> : null}
          {active || state === "paused" ? (
            <View style={{ flexDirection: "row" }}>
              <PillButton
                title={state === "paused" ? "Resume Run" : flow.pauseRequested ? "Pausing…" : "Pause Run"}
                variant="tinted"
                size="small"
                icon={state === "paused" ? PlayIcon : PauseIcon}
                disabled={!!flow.pauseRequested && state !== "paused"}
                loading={busy === "pause" || busy === "resume"}
                onPress={() => void act(state === "paused" ? "resume" : "pause")}
              />
            </View>
          ) : null}
          {state === "paused" ? (
            <Text style={styles.footnote}>
              {stopped
                ? `Paused at ${stepTitle(stopped)}. The step under way finishes; the next one waits for Resume.`
                : "Paused. The next step waits for Resume."}
            </Text>
          ) : null}
        </View>

        {state === "ended" ? (
          <View style={{ gap: space.lg, padding: space.xl, borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.inset }}>
            <Text style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{endedText(run, rows, now)}</Text>
            {flow.dryRun ? null : (
              <PillButton
                title={again ? "Run again" : "Test run"}
                icon={again ? RefreshIcon : TestTube01Icon}
                loading={busy === "again"}
                onPress={() => void runAgain()}
              />
            )}
            {askStepId ? (
              <PillButton title="Change how long approvals wait" variant="plain" size="small" onPress={() => openStep(routine.id, askStepId)} />
            ) : null}
          </View>
        ) : null}

        <View>
          <TimelineRow
            icon={<Icon icon={CheckmarkCircle02Icon} tone="green" size={20} />}
            title={triggerTitle(routine.trigger)}
            line={triggerRunLine(run)}
            last={rows.length === 0}
            depth={0}
          />
          {rows.map((row, index) => {
            const last = index === rows.length - 1;
            if (row.kind === "path") return <PathRow key={`${row.parentId}:${row.path}`} row={row} last={last} />;
            return <StepRow key={row.step.id} row={row} last={last} now={now} routine={routine} run={run} busy={busy} onAct={act} onOpenChat={openChat} />;
          })}
        </View>
      </PageScroll>
    </>
  );
}

/** What the ended notice says: why the Run ended, when, and that nothing after it ran. */
function endedText(run: RoutineRun, rows: FlowRunRow[], now: number) {
  const at = run.endedAt ? ` on ${when(run.endedAt, now)}` : "";
  for (const row of rows) {
    if (row.kind !== "step" || !row.run?.approval) continue;
    const { approval } = row.run;
    const hours = Math.max(1, Math.round((approval.expiresAt - approval.askedAt) / 3_600_000));
    if (approval.decision === "expired") return `Nobody answered ${stepTitle(row.step)} within ${hours} h, so the Run ended${at}. Nothing after it ran.`;
    if (approval.decision === "rejected")
      return `${stepTitle(row.step)} was rejected${approval.reason ? `: ${approval.reason}` : ""}. The Run ended${at}; nothing after it ran.`;
  }
  return run.error ? `The Run ended${at}: ${run.error}. Nothing after it ran.` : `The Run ended${at}. Nothing after it ran.`;
}

/** One line of the timeline: the state icon on the line that joins the steps, the name, what it did, and anything under it. */
function TimelineRow({
  icon,
  title,
  line,
  dim = false,
  lineTone,
  last,
  depth,
  children,
}: {
  icon: ReactNode;
  title: string;
  line: string;
  dim?: boolean;
  lineTone?: string;
  last: boolean;
  depth: number;
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 12, marginLeft: depth * 18 }}>
      <View style={{ width: 22, alignItems: "center" }}>
        <View style={{ height: 22, justifyContent: "center" }}>{icon}</View>
        {last ? null : <View style={{ flex: 1, width: 1, minHeight: 10, backgroundColor: colors.lineStrong, marginVertical: 2 }} />}
      </View>
      <View style={{ flex: 1, gap: space.sm, paddingBottom: last ? 0 : space.xl }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: dim ? colors.ink3 : colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600" }}>{title}</Text>
          {line ? <Text style={{ color: lineTone ?? colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{line}</Text> : null}
        </View>
        {children}
      </View>
    </View>
  );
}

/** An If's path label in the timeline: "Yes, taken", "Otherwise, not taken". */
function PathRow({ row, last }: { row: Extract<FlowRunRow, { kind: "path" }>; last: boolean }) {
  const { colors } = useTheme();
  const name = row.path === "yes" ? "Yes" : "Otherwise";
  const text = row.decided ? `${name}, ${row.taken ? "taken" : "not taken"}` : name;
  return (
    <View style={{ flexDirection: "row", gap: 12, marginLeft: (row.depth - 1) * 18 }}>
      <View style={{ width: 22, alignItems: "center" }}>{last ? null : <View style={{ flex: 1, width: 1, backgroundColor: colors.lineStrong }} />}</View>
      <View style={{ paddingBottom: space.md, paddingLeft: space.xl }}>
        <Tag
          label={row.empty && row.taken ? `${text}, nothing to run` : text}
          tone={row.taken ? "green" : "neutral"}
          square
          style={{ alignSelf: "flex-start" }}
        />
      </View>
    </View>
  );
}

/** A step of the timeline, with its output chips and Chat link, and its approval, receipt or failure under it. */
function StepRow({
  row,
  last,
  now,
  routine,
  run,
  busy,
  onAct,
  onOpenChat,
}: {
  row: Extract<FlowRunRow, { kind: "step" }>;
  last: boolean;
  now: number;
  routine: RoutineWithRuns;
  run: RoutineRun;
  busy: string;
  onAct: Act;
  onOpenChat: (key: string) => void;
}) {
  const { colors } = useTheme();
  const { step, status } = row;
  const stepRun = row.run;
  const look = stepStateLook(status, stepRun);
  const dim = status === "pending" || status === "not-run" || status === "not-taken" || status === "skipped";
  const chips = step.kind === "agent" && status === "done" ? outputChips(stepRun?.output) : [];
  const chat = step.kind === "agent" && stepRun?.chatId && status !== "pending" ? stepRun.chatId : undefined;
  const approval = stepRun?.approval;
  const asking = status === "waiting" && approval && !approval.decision;
  return (
    <TimelineRow
      icon={look.icon ? <Icon icon={look.icon} tone={look.tone} size={20} /> : <SpinnerRing size={16} tone="accent" />}
      title={stepTitle(step)}
      line={stepRunLine(row, now)}
      lineTone={status === "failed" ? colors.redInk : status === "running" ? colors.accentInk : undefined}
      dim={dim}
      last={last}
      depth={row.depth}
    >
      {chips.length || chat ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          {chips.map((text) => (
            <Tag key={text} label={text} square />
          ))}
          {chat ? <LinkText title="Open Chat" onPress={() => onOpenChat(chat)} /> : null}
        </View>
      ) : null}
      {asking && approval ? <ApprovalCard step={step} approval={approval} runLabel={runName(routine, run)} now={now} busy={busy} onAct={onAct} /> : null}
      {stepRun?.receipt ? <ReceiptCard receipt={stepRun.receipt} runLabel={runName(routine, run)} /> : null}
      {status === "failed" && stepRun ? <FailedCard step={step} stepRun={stepRun} busy={busy} onAct={onAct} onOpenChat={onOpenChat} /> : null}
    </TimelineRow>
  );
}

/** A small accent link, as "Open Chat" beside the output chips. */
function LinkText({ title, onPress }: { title: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={title}
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [{ paddingHorizontal: space.xxs }, pressStyle({ pressed })]}
    >
      <Text style={{ color: colors.accentInk, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}>{title}</Text>
    </Pressable>
  );
}

/** A card under a timeline step. */
function StepCard({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={[styles.card, { marginTop: space.xs }]}>{children}</View>;
}

/** Label and value rows inside a card, split by hairlines: what a pull request will open, or its receipt. */
function Rows({ rows }: { rows: [string, string][] }) {
  const { colors } = useTheme();
  return (
    <View
      style={{ borderRadius: radius.control, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" }}
    >
      {rows.map(([label, value], index) => (
        <View
          key={label}
          style={{
            flexDirection: "row",
            gap: space.lg,
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
            borderTopColor: colors.line,
          }}
        >
          <Text style={{ width: 92, color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{label}</Text>
          <Text selectable style={{ flex: 1, color: colors.ink, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The approval a step waits for: its message and, for a pull request, what will open and that it keeps a receipt; then
 * Approve and Reject. Reject opens a field for a reason (optional) before it ends the Run.
 */
function ApprovalCard({
  step,
  approval,
  runLabel,
  now,
  busy,
  onAct,
}: {
  step: FlowStep;
  approval: FlowApproval;
  runLabel: string;
  now: number;
  busy: string;
  onAct: Act;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const preview = approval.preview;
  const left = Math.max(1, Math.ceil((approval.expiresAt - Math.max(now, approval.askedAt)) / 3_600_000));
  const approveTitle = step.kind === "pull-request" ? (preview?.draft === false ? "Open PR" : "Open draft PR") : "Approve";
  return (
    <StepCard>
      {approval.message ? <Text style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{approval.message}</Text> : null}
      {preview ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.label}>This will open</Text>
          <Rows
            rows={[
              ...(preview.repository ? ([["Repository", preview.repository]] as [string, string][]) : []),
              ["Branches", `${preview.branch} into ${preview.base}`],
              ["Title", preview.title],
              ...(preview.changes ? ([["Changes", preview.changes]] as [string, string][]) : []),
              ["Opens as", preview.draft ? "Draft PR" : "Pull request"],
            ]}
          />
          <View style={[styles.error, { flexDirection: "row", backgroundColor: colors.greenTint }]}>
            <View style={{ paddingTop: space.xxs }}>
              <Icon icon={Invoice01Icon} tone="greenInk" size={16} />
            </View>
            <Text style={{ flex: 1, color: colors.greenInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
              {`Keeps a receipt. If ${runLabel} restarts, it finds this PR by its branch instead of opening a second one.`}
            </Text>
          </View>
        </View>
      ) : null}
      {rejecting ? (
        <View style={{ gap: space.md }}>
          <Field
            label="Reason"
            hideLabel
            multiline
            autoCapitalize="sentences"
            autoCorrect
            placeholder="Why, so the next Run can do better (optional)"
            value={reason}
            onChangeText={setReason}
            style={{ minHeight: 72, textAlignVertical: "top" }}
          />
          <View style={{ flexDirection: "row", gap: space.md }}>
            <PillButton title="Cancel" variant="tinted" onPress={() => setRejecting(false)} style={{ flex: 1 }} />
            <PillButton
              title="Reject and end"
              destructive
              loading={busy === "reject"}
              onPress={() => void onAct("reject", reason.trim() ? { reason: reason.trim() } : {}, "Could not reject.")}
              style={{ flex: 1.4 }}
            />
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: space.md }}>
          <PillButton title={approveTitle} loading={busy === "approve"} onPress={() => void onAct("approve", {}, "Could not approve.")} style={{ flex: 1 }} />
          <PillButton title="Reject" variant="tinted" destructive disabled={!!busy} onPress={() => setRejecting(true)} style={{ flex: 1 }} />
        </View>
      )}
      <Text style={styles.caption}>{`Reject asks for a reason and ends the Run. No answer in ${left} h ends it too.`}</Text>
    </StepCard>
  );
}

/** What a step did that must never happen twice: the pull request it opened (or found) or the comment it posted. */
function ReceiptCard({ receipt, runLabel }: { receipt: FlowReceipt; runLabel: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const url = receipt.url;
  const rows: [string, string][] =
    receipt.kind === "pull-request"
      ? [
          ["Pull request", `#${receipt.number}${receipt.draft ? ", draft" : ""}`],
          ["Branch", receipt.branch],
          ["Found by", receipt.matched ? "Its branch, already open" : "Opened by this Run"],
        ]
      : [["Comment", `On ${receipt.issue}`]];
  return (
    <StepCard>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Icon icon={Invoice01Icon} tone="greenInk" size={16} />
        <Text style={{ flex: 1, color: colors.greenInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>Receipt</Text>
        <Text style={{ color: colors.greenInk, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>{`saved ${clock(receipt.at)}`}</Text>
      </View>
      <Rows rows={rows} />
      {receipt.kind === "pull-request" ? <Text style={styles.caption}>{`If ${runLabel} restarts, this step finds #${receipt.number} and skips.`}</Text> : null}
      {url ? (
        <View style={{ flexDirection: "row", gap: space.md }}>
          <PillButton
            title={receipt.kind === "pull-request" ? "Open on GitHub" : "Open in Linear"}
            icon={LinkSquare02Icon}
            size="small"
            onPress={() => void Linking.openURL(url)}
            style={{ flex: 1 }}
          />
          <PillButton
            title="Copy link"
            variant="tinted"
            icon={Copy01Icon}
            size="small"
            onPress={() => void Clipboard.setStringAsync(url)}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}
    </StepCard>
  );
}

/** A step that failed: its error, the tries before it, and Retry with a note (the note goes into the next turn's prompt). */
function FailedCard({
  step,
  stepRun,
  busy,
  onAct,
  onOpenChat,
}: {
  step: FlowStep;
  stepRun: FlowStepRun;
  busy: string;
  onAct: Act;
  onOpenChat: (key: string) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(stepRun.note ?? "");
  const tries = [
    ...(stepRun.tries ?? []),
    ...(stepRun.startedAt
      ? [{ startedAt: stepRun.startedAt, endedAt: stepRun.endedAt ?? stepRun.startedAt, error: stepRun.error ?? "", chatId: stepRun.chatId }]
      : []),
  ];
  return (
    <StepCard>
      <InlineError message={stepRun.error} />
      {tries.length > 1 ? (
        <View style={{ gap: space.sm }}>
          <Text style={styles.label}>Tries</Text>
          <View style={{ borderRadius: radius.control, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
            {tries.map((item, index) => {
              const chat = item.chatId;
              return (
                <View
                  key={`${item.startedAt}:${index}`}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.md,
                    paddingHorizontal: space.lg,
                    paddingVertical: space.md,
                    borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
                    borderTopColor: colors.line,
                  }}
                >
                  <Icon icon={CancelCircleIcon} tone="red" size={16} />
                  <Text numberOfLines={2} style={{ flex: 1, color: colors.ink, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
                    {[`Try ${index + 1}`, runDuration(item.endedAt - item.startedAt), firstLine(item.error)].filter(Boolean).join(", ")}
                  </Text>
                  {chat ? <LinkText title="Chat" onPress={() => onOpenChat(chat)} /> : null}
                </View>
              );
            })}
          </View>
        </View>
      ) : null}
      {noting ? (
        <View style={{ gap: space.md }}>
          <Field
            label="Note"
            hideLabel
            multiline
            autoCapitalize="sentences"
            autoCorrect
            placeholder="What to do differently this time"
            value={note}
            onChangeText={setNote}
            style={{ minHeight: 72, textAlignVertical: "top" }}
          />
          <View style={{ flexDirection: "row", gap: space.md }}>
            <PillButton title="Cancel" variant="tinted" onPress={() => setNoting(false)} style={{ flex: 1 }} />
            <PillButton
              title="Retry"
              icon={RefreshIcon}
              loading={busy === "retry"}
              onPress={() => void onAct("retry", note.trim() ? { note: note.trim() } : {}, "Could not retry this step.")}
              style={{ flex: 1.4 }}
            />
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: space.md }}>
          <PillButton title="Retry with a note" icon={RefreshIcon} disabled={!!busy} onPress={() => setNoting(true)} style={{ flex: 1.3 }} />
          {stepRun.chatId ? <PillButton title="Open last Chat" variant="tinted" onPress={() => onOpenChat(stepRun.chatId!)} style={{ flex: 1 }} /> : null}
        </View>
      )}
      <Text style={styles.caption}>
        {`Retry runs ${stepTitle(step)} again${step.kind === "agent" ? " in the same Worktree with your note added to the prompt" : ""}. Later steps run as usual.`}
      </Text>
    </StepCard>
  );
}
