import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Archive02Icon, ArrowLeft01Icon, Cancel01Icon, RefreshIcon, SquareIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { advisorAction, subagentActivityLabel } from "@milagre/shared/agent-activity";
import { subagentFinished } from "@milagre/shared/project-edits";
import type { Subagent } from "@milagre/shared/model";
import { subagentCounts, subagentTree, type SubagentTreeRow } from "@milagre/shared/subagent-tree";
import { useSession } from "../session";
import { qaFleetFirst, qaPersona } from "@milagre/shared/qa-personas";
import { WholeSubagentDetail, SubagentRow, elapsed, subagentRunning, useClock } from "../subagent-glance";
import { PersonaAvatar } from "../persona-avatar";
import { Icon } from "../icons";
import { CircleButton, EmptyState, ErrorNotice, IconButton, ListRow, PageScroll, SheetHeader, useStyles } from "../ui";
import { useTheme } from "../theme";
import { lineHeight, type } from "../design-tokens";

const INDENT = 28;
const ICON_CENTER_X = 9;
const ICON_CENTER_Y = 23;
const TEXT_X = 30;
const guideX = (level: number) => ICON_CENTER_X + level * INDENT;

function BranchLines({ row }: { row: SubagentTreeRow }) {
  const { colors } = useTheme();
  const line = { position: "absolute", width: 1, backgroundColor: colors.lineStrong } as const;
  return (
    <>
      {row.rails
        .flatMap((on, level) => (on ? [guideX(level)] : []))
        .map((left) => (
          <View key={left} pointerEvents="none" style={[line, { left, top: 0, bottom: 0 }]} />
        ))}
      {row.depth > 0 && (
        <>
          <View pointerEvents="none" style={[line, { left: guideX(row.depth - 1), top: 0, ...(row.last ? { height: ICON_CENTER_Y + 1 } : { bottom: 0 }) }]} />
          <View pointerEvents="none" style={[line, { left: guideX(row.depth - 1), top: ICON_CENTER_Y, width: 14, height: 1 }]} />
        </>
      )}
      {row.children > 0 && !row.folded && <View pointerEvents="none" style={[line, { left: guideX(row.depth), top: ICON_CENTER_Y + 12, bottom: 0 }]} />}
    </>
  );
}

export default function AgentsSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef(false);
  const project = session.snapshot?.project;
  const chat = project?.state.sessions[Number(id)];
  const agents = chat?.subagents || [];
  const visible = agents.filter((agent) => !agent.archived);
  const child = visible.find((agent) => agent.id === selected);
  const disabled = busy || !session.client || !chat;
  const provider = chat?.provider ?? "claude";
  const { running, failed, done } = subagentCounts(visible);
  const now = useClock(visible.some(subagentRunning));
  const { fleet, others } = qaFleetFirst(visible);
  const tree = subagentTree(others, folded);
  const rows: { agent: Subagent; item?: SubagentTreeRow }[] = [
    ...fleet.map((agent) => ({ agent })),
    ...(tree.nested ? tree.rows.map((item) => ({ agent: item.agent, item })) : others.map((agent) => ({ agent }))),
  ];
  const toggle = (agentId: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(agentId)) next.add(agentId);
      return next;
    });

  async function control(action: "stop" | "retry", agentId: string) {
    if (pending.current || !session.client || !project || !chat) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      session.expectActivity();
      await session.client.call(`advisor:${action}`, [`${project.path}#${chat.id}`, agentId]);
      await session.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function archive(agentId?: string) {
    if (pending.current || !session.client || !project || !chat) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      session.expectActivity();
      if (agentId === undefined) await session.client.call("chat:archive-finished-subagents", [project.path, chat.id]);
      else await session.client.call("chat:archive-subagent", [project.path, chat.id, agentId, true]);
      await session.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const action = child ? advisorAction(child) : undefined;
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0, paddingBottom: 40 }}>
      <SheetHeader
        style={{ backgroundColor: colors.page }}
        title={child ? (qaPersona(child)?.name ?? child.title) : "Subagents"}
        subtitle={
          (child
            ? [subagentActivityLabel(child), elapsed(child, now), child.model].filter(Boolean).join(" · ")
            : [running && `${running} running`, failed && `${failed} failed`, done && `${done} done`].filter(Boolean).join(" · ")) || undefined
        }
        leading={
          child ? (
            <CircleButton label="Back to subagents" icon={ArrowLeft01Icon} onPress={() => setSelected(null)} />
          ) : (
            <CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />
          )
        }
        trailing={
          child && action ? (
            <CircleButton
              label={`${action === "stop" ? "Stop" : "Retry"} ${child.title}`}
              icon={action === "stop" ? SquareIcon : RefreshIcon}
              disabled={disabled}
              onPress={() => control(action, child.id)}
            />
          ) : undefined
        }
      />
      {error ? (
        <View style={{ paddingHorizontal: 16 }}>
          <ErrorNotice message={error} />
        </View>
      ) : null}
      {child ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <WholeSubagentDetail agent={child} read={() => session.client!.call("chat:subagent", [project!.path, chat!.id, child.id]) as Promise<Subagent>} />
          <ListRow
            title="Archive subagent"
            leading={<Icon icon={Archive02Icon} tone="ink2" size={20} />}
            chevron={false}
            disabled={disabled || action === "stop"}
            onPress={() => {
              setSelected(null);
              void archive(child.id);
            }}
          />
        </View>
      ) : (
        <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
          {!visible.length && <EmptyState icon={UserMultipleIcon} title="No subagents to show" />}
          {fleet.length > 0 && (
            <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 8, paddingBottom: 2 }}>
              <View style={{ flexDirection: "row", paddingLeft: 6 }}>
                {fleet.slice(0, 5).map((agent) => (
                  <View key={agent.id} style={{ marginLeft: -6 }}>
                    <PersonaAvatar persona={qaPersona(agent)!} size={24} />
                  </View>
                ))}
              </View>
              <Text style={{ flex: 1, color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>QA fleet</Text>
              <Text style={styles.footnote}>
                {fleet.length} {fleet.length === 1 ? "persona" : "personas"}
              </Text>
            </View>
          )}
          {rows.map(({ agent, item }, index) => (
            <View
              key={agent.id}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 4,
                paddingLeft: item ? item.depth * INDENT : 0,
                borderTopWidth: index && !item ? StyleSheet.hairlineWidth : 0,
                borderTopColor: colors.line,
              }}
            >
              {item && index > 0 && (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    left: item.depth * INDENT + TEXT_X,
                    height: StyleSheet.hairlineWidth,
                    backgroundColor: colors.line,
                  }}
                />
              )}
              {item && <BranchLines row={item} />}
              <SubagentRow
                agent={agent}
                provider={provider}
                now={now}
                onPress={() => setSelected(agent.id)}
                branch={item?.children ? { count: item.children, folded: item.folded, hidden: item.hidden, onToggle: () => toggle(agent.id) } : undefined}
              />
              {advisorAction(agent) && (
                <IconButton
                  label={`${advisorAction(agent) === "stop" ? "Stop" : "Retry"} ${agent.title}`}
                  icon={advisorAction(agent) === "stop" ? Cancel01Icon : RefreshIcon}
                  size={44}
                  disabled={disabled}
                  onPress={() => control(advisorAction(agent)!, agent.id)}
                />
              )}
            </View>
          ))}
          <ListRow
            title="Archive finished"
            leading={<Icon icon={Archive02Icon} tone="ink2" size={20} />}
            chevron={false}
            disabled={disabled || !visible.some(subagentFinished)}
            onPress={() => archive()}
          />
        </View>
      )}
    </PageScroll>
  );
}
