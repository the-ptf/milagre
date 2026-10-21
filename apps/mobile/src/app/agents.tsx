import { useMemo, useRef, useState } from "react";
import { Text, View, type ScrollViewInstance } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Archive02Icon, ArrowLeft01Icon, Cancel01Icon, RefreshIcon, SquareIcon } from "@hugeicons/core-free-icons";
import { advisorAction, agentActivityLabel, subagentActivityLabel } from "@milagre/shared/agent-activity";
import { subagentFinished } from "@milagre/shared/project-edits";
import type { Subagent } from "@milagre/shared/model";
import { useSession } from "../session";
import { WholeSubagentDetail, elapsed, subagentRunning, useClock } from "../subagent-glance";
import { buildSubagentTree } from "@milagre/shared/subagent-tree";
import { SubagentOutline } from "../subagent-tree";
import { Icon } from "../icons";
import { CircleButton, ErrorNotice, ListRow, PageScroll, Segmented, useStyles } from "../ui";
import { useTheme } from "../theme";
import { useReducedMotion } from "../motion";

/**
 * The Chat's subagents, like desktop's subagent popover: each row says what the subagent does now and how far it got;
 * tapping one shows its plan, task and outcome in the same sheet.
 */
export default function AgentsSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [chosenMode, setChosenMode] = useState<"list" | "tree" | null>(null);
  const [initialMode, setInitialMode] = useState<"list" | "tree" | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [rootCollapsed, setRootCollapsed] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const listTop = useRef(0);
  const outlineTop = useRef(0);
  const reduced = useReducedMotion();
  const pending = useRef(false);
  const project = session.snapshot?.project;
  const chat = project?.state.sessions[Number(id)];
  const agents = chat?.subagents;
  const tree = useMemo(() => buildSubagentTree(agents ?? []), [agents]);
  const visible = Array.from(tree.nodes.values(), (node) => node.agent);
  if (initialMode === null && chat) setInitialMode(tree.nested ? "tree" : "list");
  const mode = chosenMode ?? initialMode ?? (tree.nested ? "tree" : "list");
  const child = visible.find((agent) => agent.id === selected);
  const disabled = busy || !session.client || !chat;
  const provider = chat?.provider ?? "claude";
  const running = tree.counts.running;
  const done = tree.counts.done;
  const now = useClock(visible.some(subagentRunning));
  const run = project && chat ? session.snapshot?.runs.runs[`${project.path}#${chat.id}`] : undefined;
  const rootStatus = run
    ? run.questions.length || run.approvals.length || run.waitingForSubagents
      ? "Waiting"
      : "Running"
    : chat?.summary?.lastOutcome === "failed"
      ? "Failed"
      : "Idle";
  const latestStep = run?.steps.findLast((step) => step.status === "running");

  async function control(action: "stop" | "retry", agentId: string) {
    if (pending.current || !session.client || !project || !chat) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      session.expectActivity();
      await session.client.call(`advisor:${action}`, [`${project.path}#${chat.id}`, agentId]);
      await session.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function archive(agentId?: string) {
    if (pending.current || !session.client || !project || !chat) return false;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      session.expectActivity();
      if (agentId === undefined) await session.client.call("chat:archive-finished-subagents", [project.path, chat.id]);
      else await session.client.call("chat:archive-subagent", [project.path, chat.id, agentId, true]);
      await session.refresh();
      if (agentId !== undefined) setSelected(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const action = child ? advisorAction(child) : undefined;
  return (
    <PageScroll ref={scroll} style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0, paddingBottom: 40 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: 8,
          backgroundColor: colors.page,
        }}
      >
        {child ? (
          <CircleButton label="Back to subagents" icon={ArrowLeft01Icon} onPress={() => setSelected(null)} />
        ) : (
          <CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />
        )}
        <View style={{ flex: 1, alignItems: "center", gap: 1 }}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
            {child ? child.title : "Subagents"}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 13 }}>
            {child
              ? [subagentActivityLabel(child), elapsed(child, now), child.model].filter(Boolean).join(" · ")
              : [running && `${running} running`, done && `${done} done`].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {child && action ? (
          <CircleButton
            label={`${action === "stop" ? "Stop" : "Retry"} ${child.title}`}
            icon={action === "stop" ? SquareIcon : RefreshIcon}
            onPress={disabled ? undefined : () => control(action, child.id)}
          />
        ) : (
          <View style={{ width: 40 }} />
        )}
      </View>
      {error ? (
        <View style={{ paddingHorizontal: 20 }}>
          <ErrorNotice message={error} />
        </View>
      ) : null}
      {child ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
          <WholeSubagentDetail agent={child} read={() => session.client!.call("chat:subagent", [project!.path, chat!.id, child.id]) as Promise<Subagent>} />
          <ListRow
            title="Archive subagent"
            leading={<Icon icon={Archive02Icon} tone="ink2" size={20} />}
            trailing={<View />}
            disabled={disabled || action === "stop"}
            onPress={() => {
              void archive(child.id);
            }}
          />
        </View>
      ) : (
        <View
          onLayout={(event) => {
            listTop.current = event.nativeEvent.layout.y;
          }}
          style={{ paddingHorizontal: 20, paddingTop: 4, gap: 12 }}
        >
          <Segmented
            label="Subagents view"
            value={mode}
            options={[
              { value: "list", title: "List" },
              { value: "tree", title: "Tree" },
            ]}
            onChange={(value) => setChosenMode(value as "list" | "tree")}
          />
          {!visible.length && <Text style={[styles.muted, { paddingVertical: 16 }]}>No subagents to show.</Text>}
          {chat && (
            <View
              onLayout={(event) => {
                outlineTop.current = event.nativeEvent.layout.y;
              }}
            >
              <SubagentOutline
                tree={tree}
                mode={mode}
                collapsed={collapsed}
                onCollapsed={setCollapsed}
                rootCollapsed={rootCollapsed}
                onRootCollapsed={setRootCollapsed}
                focused={focused}
                onFocused={setFocused}
                chat={chat}
                rootModel={run?.model || chat.summary?.lastModel}
                rootStatus={rootStatus}
                rootActivity={
                  run ? (run.waitingForSubagents ? "Waiting for subagents" : latestStep ? agentActivityLabel(latestStep.title) : undefined) : undefined
                }
                provider={provider}
                now={now}
                disabled={disabled}
                onOpen={setSelected}
                onControl={control}
                onScrollTo={(y) => scroll.current?.scrollTo({ y: Math.max(0, listTop.current + outlineTop.current + y - 12), animated: !reduced })}
              />
            </View>
          )}
          <ListRow
            title="Archive finished"
            leading={<Icon icon={Archive02Icon} tone="ink2" size={20} />}
            trailing={<View />}
            disabled={disabled || !visible.some(subagentFinished)}
            onPress={() => archive()}
          />
        </View>
      )}
    </PageScroll>
  );
}
