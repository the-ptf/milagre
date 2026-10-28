import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Archive02Icon, ArrowLeft01Icon, Cancel01Icon, RefreshIcon, SquareIcon } from "@hugeicons/core-free-icons";
import { advisorAction, subagentActivityLabel } from "@milagre/shared/agent-activity";
import { subagentFinished } from "@milagre/shared/project-edits";
import type { Subagent } from "@milagre/shared/model";
import { useSession } from "../session";
import { qaFleetFirst, qaPersona } from "@milagre/shared/qa-personas";
import { PersonaAvatar, WholeSubagentDetail, SubagentRow, elapsed, subagentRunning, useClock } from "../subagent-glance";
import { Icon } from "../icons";
import { CircleButton, ErrorNotice, IconButton, ListRow, PageScroll, useStyles } from "../ui";
import { useTheme } from "../theme";

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
  const pending = useRef(false);
  const project = session.snapshot?.project;
  const chat = project?.state.sessions[Number(id)];
  const agents = chat?.subagents || [];
  const visible = agents.filter((agent) => !agent.archived);
  const child = visible.find((agent) => agent.id === selected);
  const disabled = busy || !session.client || !chat;
  const provider = chat?.provider ?? "claude";
  const running = visible.filter(subagentRunning).length;
  const done = visible.filter(subagentFinished).length;
  const now = useClock(visible.some(subagentRunning));
  // The QA fleet's personas come first, under their own header, as on desktop.
  const { fleet, others } = qaFleetFirst(visible);

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
            {child ? (qaPersona(child)?.name ?? child.title) : "Subagents"}
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
              setSelected(null);
              void archive(child.id);
            }}
          />
        </View>
      ) : (
        <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
          {!visible.length && <Text style={[styles.muted, { paddingVertical: 16 }]}>No subagents to show.</Text>}
          {fleet.length > 0 && (
            <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 8, paddingBottom: 2 }}>
              <View style={{ flexDirection: "row", paddingLeft: 6 }}>
                {fleet.slice(0, 5).map((agent) => (
                  <View key={agent.id} style={{ marginLeft: -6 }}>
                    <PersonaAvatar persona={qaPersona(agent)!} size={24} />
                  </View>
                ))}
              </View>
              <Text style={{ flex: 1, color: colors.ink2, fontSize: 15, fontWeight: "600" }}>QA fleet</Text>
              <Text style={{ color: colors.ink3, fontSize: 13 }}>
                {fleet.length} {fleet.length === 1 ? "persona" : "personas"}
              </Text>
            </View>
          )}
          {[...fleet, ...others].map((agent, index) => (
            <View key={agent.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: 4, borderTopWidth: index ? 1 : 0, borderTopColor: colors.line }}>
              <SubagentRow agent={agent} provider={provider} now={now} onPress={() => setSelected(agent.id)} />
              {/* As on desktop, an advisor's Stop or Retry stays on its row. */}
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
            trailing={<View />}
            disabled={disabled || !visible.some(subagentFinished)}
            onPress={() => archive()}
          />
        </View>
      )}
    </PageScroll>
  );
}
