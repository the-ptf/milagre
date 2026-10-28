import { useEffect, useRef, useState, type ComponentType } from "react";
import Svg, { Circle, Ellipse, Polygon, Rect } from "react-native-svg";
import { useDisplayNow } from "./display-clock";
import { formatElapsed } from "@milagre/shared/display-clock";
import { Pressable, Text, View } from "react-native";
import {
  AlertCircleIcon,
  ArrowRight01Icon,
  CommandLineIcon,
  File01Icon,
  Image01Icon,
  PencilEdit01Icon,
  ScrollIcon,
  Search01Icon,
  Tick02Icon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";
import { subagentActivityLabel, subagentRoleLabel } from "@milagre/shared/agent-activity";
import type { AgentTask, ModelProvider, Subagent, ToolCategory } from "@milagre/shared/model";
import { qaPersona, type BloubShape, type QaPersona } from "@milagre/shared/qa-personas";
import { lastSaid, planCounts, plainTitle, subagentOutcome, subagentSteps, toolChips, toolSummary, type SubagentStep } from "@milagre/shared/subagent-glance";
import { Icon, ProviderLogo, SpinnerRing, type IconData } from "./icons";
import { fonts, useTheme } from "./theme";

// Desktop's subagent panel on the phone (SubagentTrack.tsx): a row says what each subagent does now and how far it got,
// and its detail shows its own plan (or what it said, step by step), its task and outcome, with the log behind Full log.

const chipIcons: Record<ToolCategory, IconData> = {
  commands: CommandLineIcon,
  images: Image01Icon,
  reads: File01Icon,
  searches: Search01Icon,
  edits: PencilEdit01Icon,
  other: WrenchIcon,
};
// The face's shapes by SVG element name; their props come from qa-personas.ts as SVG attributes.
const faceShapes: Record<BloubShape["type"], ComponentType<Record<string, string | number>>> = {
  rect: Rect as ComponentType,
  circle: Circle as ComponentType,
  ellipse: Ellipse as ComponentType,
  polygon: Polygon as ComponentType,
};
const PHASES = new Set(["Responding", "Thinking", "Finished"]);
const entries = (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`;

export const subagentRunning = (agent: Subagent) => ["initializing", "running", "waiting"].includes(agent.status);

export function elapsed(agent: Subagent, now: number) {
  return formatElapsed((agent.endedAt ?? now) - agent.startedAt);
}

/**
 * `agent` with its whole transcript, read with `read` when the host sent only its end, and read again (at most every two
 * seconds) as it grows. An older host that can't read it leaves the end.
 */
function useWholeSubagent(agent: Subagent, read: () => Promise<Subagent>): Subagent {
  const [whole, setWhole] = useState<Subagent | null>(null);
  const partial = typeof agent.transcriptLength === "number" && agent.transcriptLength > agent.transcript.length;
  const length = agent.transcriptLength ?? agent.transcript.length;
  const reading = useRef({ last: 0, read });
  useEffect(() => {
    reading.current.read = read;
  }, [read]);
  useEffect(() => {
    if (!partial) return;
    let live = true;
    const wait = Math.max(0, reading.current.last + 2000 - Date.now());
    const timer = setTimeout(() => {
      reading.current.last = Date.now();
      reading.current.read().then(
        (result) => live && setWhole(result),
        () => {},
      );
    }, wait);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [partial, length, agent.id]);
  if (!partial || !whole || whole.id !== agent.id) return agent;
  // The live fields come from the update; the read brings the transcript the update leaves out.
  return { ...agent, transcript: whole.transcript.length >= agent.transcript.length ? whole.transcript : agent.transcript, transcriptLength: undefined };
}

/** The time, ticking each second while `running`. */
export function useClock(running: boolean) {
  return useDisplayNow(1000, running);
}

function useText() {
  const { colors } = useTheme();
  return {
    colors,
    label: { color: colors.ink3, fontSize: 13, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" } as const,
  };
}

/** A QA persona's face, as on desktop (qa-personas.ts): a solid blob with white eyes, the same in light and dark. */
export function PersonaAvatar({ persona, size }: { persona: QaPersona; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="-50 -50 100 100" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {persona.face.map((shape, index) => {
        const Shape = faceShapes[shape.type];
        return <Shape key={index} {...shape.props} />;
      })}
    </Svg>
  );
}

function QaTag({ persona }: { persona: QaPersona }) {
  return (
    <View style={{ borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: persona.tint }}>
      <Text style={{ color: persona.ink, fontSize: 10, fontWeight: "700" }}>QA</Text>
    </View>
  );
}

/** Who the persona plays, above its plan. */
function PersonaCard({ persona }: { persona: QaPersona }) {
  return (
    <View style={{ gap: 10, padding: 16, borderRadius: 16, backgroundColor: persona.tint }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <PersonaAvatar persona={persona} size={44} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: persona.ink, fontSize: 17, fontWeight: "600" }}>{persona.title}</Text>
          <Text style={{ color: persona.ink, opacity: 0.8, fontSize: 15 }}>{persona.tagline}</Text>
        </View>
      </View>
      {persona.chips && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {persona.chips.map((chip) => (
            <Text
              key={chip}
              style={{
                color: persona.ink,
                fontSize: 13,
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 6,
                overflow: "hidden",
                backgroundColor: "rgba(255,255,255,0.6)",
              }}
            >
              {chip}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

function StatusIcon({ agent, provider }: { agent: Subagent; provider: ModelProvider }) {
  if (subagentRunning(agent)) return <SpinnerRing size={16} />;
  if (agent.status === "failed") return <Icon icon={AlertCircleIcon} tone="ink3" size={18} />;
  return <ProviderLogo provider={agent.provider ?? provider} size={16} />;
}

/** A list row: status, title, time, what it says now (or its outcome), and how far it got. */
export function SubagentRow({ agent, provider, now, onPress }: { agent: Subagent; provider: ModelProvider; now: number; onPress: () => void }) {
  const { colors } = useTheme();
  const running = subagentRunning(agent);
  const counts = planCounts(agent.tasks);
  const said = agent.progress?.said ?? lastSaid(subagentSteps(agent.transcript));
  const line = running ? (said ?? subagentActivityLabel(agent)) : (subagentOutcome(agent.transcript) ?? said ?? subagentActivityLabel(agent));
  const meta = [
    counts ? `${counts.done} of ${counts.total}` : agent.progress?.steps ? `Step ${agent.progress.steps}` : "",
    toolSummary(agent.progress?.tools),
    subagentRoleLabel(agent),
  ]
    .filter(Boolean)
    .join(" · ");
  const persona = qaPersona(agent);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${persona ? `${persona.name} QA persona, ${agent.title}` : agent.title}. ${subagentActivityLabel(agent)}. ${line}`}
      accessibilityHint="Opens what this subagent is doing"
      onPress={onPress}
      style={({ pressed }) => ({ flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 12, opacity: pressed ? 0.5 : 1 })}
    >
      {persona ? (
        <PersonaAvatar persona={persona} size={36} />
      ) : (
        <View style={{ width: 18, height: 22, alignItems: "center", justifyContent: "center" }}>
          <StatusIcon agent={agent} provider={provider} />
        </View>
      )}
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: persona ? "center" : "baseline", gap: 8 }}>
          <Text
            numberOfLines={1}
            style={{ flex: persona ? undefined : 1, flexShrink: 1, color: running ? colors.ink : colors.ink2, fontSize: 17, fontWeight: "600" }}
          >
            {persona?.name ?? agent.title}
          </Text>
          {persona && (
            <>
              <QaTag persona={persona} />
              <View style={{ flex: 1 }} />
              {running ? <SpinnerRing size={14} /> : agent.status === "failed" && <Icon icon={AlertCircleIcon} tone="ink3" size={16} />}
            </>
          )}
          <Text style={{ color: colors.ink3, fontSize: 13, fontVariant: ["tabular-nums"] }}>{elapsed(agent, now)}</Text>
        </View>
        {!!line && (
          <Text numberOfLines={2} style={{ color: running ? colors.ink2 : colors.ink3, fontSize: 15, lineHeight: 20 }}>
            {line}
          </Text>
        )}
        {!!meta && (
          <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 13 }}>
            {meta}
          </Text>
        )}
      </View>
      <View style={{ height: 22, justifyContent: "center" }}>
        <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
      </View>
    </Pressable>
  );
}

function StepNumber({ value, current }: { value: number; current?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        minWidth: 20,
        height: 20,
        borderRadius: 5,
        paddingHorizontal: 4,
        marginTop: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: current ? colors.hover2 : colors.hover,
      }}
    >
      <Text style={{ color: current ? colors.ink2 : colors.ink3, fontSize: 12, fontVariant: ["tabular-nums"] }}>{value}</Text>
    </View>
  );
}

function ToolChips({ counts }: { counts?: SubagentStep["tools"] }) {
  const { colors } = useTheme();
  const chips = toolChips(counts);
  if (!chips.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {chips.map((chip) => (
        <View
          key={chip.category}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            borderRadius: 6,
            paddingHorizontal: 6,
            paddingVertical: 3,
            backgroundColor: colors.hover,
          }}
        >
          <Icon icon={chipIcons[chip.category]} tone="ink3" size={12} />
          <Text style={{ color: colors.ink3, fontSize: 12 }}>{chip.label}</Text>
        </View>
      ))}
    </View>
  );
}

function PlanList({ tasks, said, tool }: { tasks: AgentTask[]; said?: string; tool?: string }) {
  const { colors, label } = useText();
  const counts = planCounts(tasks)!;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text accessibilityRole="header" style={label}>
          Plan
        </Text>
        <Text style={{ color: colors.ink3, fontSize: 13 }}>
          {counts.done} of {counts.total} done
        </Text>
      </View>
      {tasks.map((task, index) => {
        const current = task.status === "in_progress";
        return (
          <View
            key={task.id}
            accessibilityLabel={`${task.status === "completed" ? "Done" : current ? "In progress" : "Next"}: ${current && task.activeForm ? task.activeForm : task.content}`}
            style={[
              { gap: 8, padding: 8, marginHorizontal: -8, borderRadius: 14, borderWidth: 1, borderColor: "transparent" },
              current && { backgroundColor: colors.hover, borderColor: colors.lineStrong },
            ]}
          >
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
              <StepNumber value={index + 1} current={current} />
              <Text
                style={{
                  flex: 1,
                  color: task.status === "completed" ? colors.ink3 : current ? colors.ink : colors.ink2,
                  fontSize: current ? 17 : 15,
                  fontWeight: current ? "600" : "400",
                  lineHeight: current ? 22 : 20,
                }}
              >
                {current && task.activeForm ? task.activeForm : task.content}
              </Text>
              <View style={{ width: 16, height: 20, alignItems: "center", justifyContent: "center" }}>
                {current ? (
                  <SpinnerRing size={14} />
                ) : task.status === "completed" ? (
                  <Icon icon={Tick02Icon} tone="ink3" size={16} />
                ) : (
                  <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 1.5, borderColor: colors.lineStrong }} />
                )}
              </View>
            </View>
            {current && (!!said || !!tool) && (
              <View style={{ paddingLeft: 30, gap: 4 }}>
                {!!said && <Text style={{ color: colors.ink2, fontSize: 15, lineHeight: 20 }}>{said}</Text>}
                {!!tool && (
                  <Text numberOfLines={2} style={{ color: colors.ink3, fontSize: 13 }}>
                    {tool}
                  </Text>
                )}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

function StepList({ steps, title }: { steps: SubagentStep[]; title: string }) {
  const { colors, label } = useText();
  if (!steps.length) return null;
  return (
    <View style={{ gap: 14 }}>
      <Text accessibilityRole="header" style={label}>
        {title}
      </Text>
      {steps.map((step, index) => (
        <View key={step.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
          <StepNumber value={index + 1} />
          <View style={{ flex: 1, gap: 6 }}>
            <Text numberOfLines={2} style={{ color: colors.ink3, fontSize: 15, lineHeight: 20 }}>
              {step.said || "Getting started"}
            </Text>
            <ToolChips counts={step.tools} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Text cut to a few lines, with Show all once it is cut. */
function Clamped({ text, lines, style }: { text: string; lines: number; style: object }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  return (
    <View style={{ gap: 4, alignItems: "flex-start" }}>
      <Text selectable numberOfLines={open ? undefined : lines} style={[style, { alignSelf: "stretch" }]}>
        {text}
      </Text>
      {/* An unclamped copy, never shown, says whether the text runs past the clamp. */}
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[style, { position: "absolute", opacity: 0, left: 0, right: 0 }]}
        onTextLayout={(event) => setCut(event.nativeEvent.lines.length > lines)}
      >
        {text}
      </Text>
      {(cut || open) && (
        <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} hitSlop={8}>
          <Text style={{ color: colors.ink3, fontSize: 15 }}>{open ? "Show less" : "Show all"}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** One subagent at a glance; the whole transcript sits behind Full log. */
function SubagentDetail({ agent }: { agent: Subagent }) {
  const { colors, label } = useText();
  const [log, setLog] = useState(false);
  const running = subagentRunning(agent);
  const steps = subagentSteps(agent.transcript);
  const current = steps.at(-1);
  const said = agent.progress?.said ?? current?.said;
  const latest = agent.latestActivity && !PHASES.has(agent.latestActivity) ? agent.latestActivity : current?.lastTool;
  const tool = running && latest ? plainTitle(latest) : undefined;
  let result: string | undefined;
  for (let index = agent.transcript.length - 1; index >= 0 && result === undefined; index--) {
    const entry = agent.transcript[index];
    if (entry?.kind === "message" && (entry.id === "result" || entry.id === "summary")) result = entry.text;
  }
  result ??= agent.latestActivity && !PHASES.has(agent.latestActivity) && !running ? agent.latestActivity : undefined;
  const plan = agent.tasks?.length ? agent.tasks : undefined;
  const totals = toolSummary(agent.progress?.tools);
  const persona = qaPersona(agent);
  return (
    <View style={{ gap: 22 }}>
      {persona && <PersonaCard persona={persona} />}
      {plan ? (
        <PlanList tasks={plan} said={said} tool={running ? [tool, totals && `${totals} so far`].filter(Boolean).join(" · ") : undefined} />
      ) : (
        <>
          {running && current && (
            <View style={{ gap: 8, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.hover }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <SpinnerRing size={13} />
                <Text style={label}>Now · step {steps.length}</Text>
              </View>
              <Text numberOfLines={3} style={{ color: colors.ink, fontSize: 20, fontWeight: "600", lineHeight: 26 }}>
                {current.said || subagentActivityLabel(agent)}
              </Text>
              {!!tool && (
                <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 15 }}>
                  {tool}
                </Text>
              )}
            </View>
          )}
          <StepList steps={running ? steps.slice(0, -1) : steps} title={running ? "Earlier" : "Steps"} />
        </>
      )}
      {!!result && (
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" style={label}>
            Result
          </Text>
          <Clamped text={result} lines={6} style={{ color: colors.ink2, fontSize: 15, lineHeight: 20 }} />
        </View>
      )}
      {!!agent.prompt && (
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" style={label}>
            Task
          </Text>
          <Clamped text={agent.prompt} lines={2} style={{ color: colors.ink2, fontSize: 15, lineHeight: 20 }} />
        </View>
      )}
      {!agent.transcript.length && !plan && <Text style={{ color: colors.ink3, fontSize: 15 }}>No child output received yet.</Text>}
      {agent.transcript.length > 0 && (
        <View style={{ gap: 12 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: log }}
            onPress={() => setLog(!log)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: 48,
              paddingHorizontal: 14,
              borderRadius: 14,
              backgroundColor: colors.hover,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Icon icon={ScrollIcon} tone="ink3" size={18} />
            <Text style={{ flex: 1, color: colors.ink2, fontSize: 15 }}>{log ? "Hide full log" : `Full log (${entries(agent.transcript.length)})`}</Text>
          </Pressable>
          {log &&
            agent.transcript.map((entry) => (
              <Text
                key={entry.id}
                selectable
                style={
                  entry.kind === "tool"
                    ? { color: colors.ink2, fontSize: 12, lineHeight: 18, fontFamily: fonts.mono }
                    : { color: colors.ink2, fontSize: 15, lineHeight: 20 }
                }
              >
                {entry.text}
              </Text>
            ))}
        </View>
      )}
    </View>
  );
}

export function WholeSubagentDetail({ agent, read }: { agent: Subagent; read: () => Promise<Subagent> }) {
  return <SubagentDetail agent={useWholeSubagent(agent, read)} />;
}
