import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Text, View, type ViewInstance } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { ArrowDown01Icon, ArrowRight01Icon, Cancel01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { advisorAction } from "@milagre/shared/agent-activity";
import type { AgentSession, ModelProvider } from "@milagre/shared/model";
import { taskCounts } from "@milagre/shared/chat-plan";
import { providerName } from "@milagre/shared/providers";
import { flattenSubagentTree, subagentAncestors, subagentStatusLabel, type SubagentTree } from "@milagre/shared/subagent-tree";
import { ProviderLogo } from "./icons";
import { useReducedMotion } from "./motion";
import { SubagentRow } from "./subagent-glance";
import { IconButton, PillButton } from "./ui";
import { useTheme } from "./theme";

type Status = "running" | "waiting" | "failed";
const statuses: Status[] = ["running", "waiting", "failed"];
const statusTitles = { running: "Running", waiting: "Waiting", failed: "Failed" };

/** The same agents and detail controls as List, arranged as a phone-width outline. */
export function SubagentOutline({
  tree,
  mode,
  collapsed,
  onCollapsed,
  rootCollapsed,
  onRootCollapsed,
  focused,
  onFocused,
  chat,
  rootModel,
  rootActivity,
  rootStatus,
  provider,
  now,
  disabled,
  onOpen,
  onControl,
  onScrollTo,
}: {
  tree: SubagentTree;
  mode: "list" | "tree";
  collapsed: ReadonlySet<string>;
  onCollapsed: (next: Set<string>) => void;
  rootCollapsed: boolean;
  onRootCollapsed: (value: boolean) => void;
  focused: string | null;
  onFocused: (id: string) => void;
  chat: AgentSession;
  rootModel?: string;
  rootActivity?: string;
  rootStatus: string;
  provider: ModelProvider;
  now: number;
  disabled: boolean;
  onOpen: (id: string) => void;
  onControl: (action: "stop" | "retry", id: string) => void;
  onScrollTo: (y: number) => void;
}) {
  const { colors, motionScale } = useTheme();
  const reduced = useReducedMotion();
  const [announcement, setAnnouncement] = useState({ text: "", revision: 0, targetId: "", status: "" });
  const announcedAgent = tree.nodes.get(announcement.targetId)?.agent;
  const showAnnouncement = !!announcement.text && focused === announcement.targetId && announcedAgent?.status === announcement.status;
  const rowPositions = useRef(new Map<string, number>());
  const rowRefs = useRef(new Map<string, ViewInstance>());
  const rowsTop = useRef(0);
  const pendingReveal = useRef<{ id: string } | null>(null);
  useEffect(
    () => () => {
      pendingReveal.current = null;
    },
    [],
  );
  const [appearance, setAppearance] = useState(() => ({ tree, mode, collapsed, rootCollapsed, seen: new Set(tree.nodes.keys()), arriving: new Set<string>() }));
  if (appearance.tree !== tree || appearance.mode !== mode || appearance.collapsed !== collapsed || appearance.rootCollapsed !== rootCollapsed) {
    const seen = new Set(appearance.seen);
    const arriving = new Set<string>();
    for (const id of tree.nodes.keys()) {
      if (!seen.has(id) && appearance.mode === mode && appearance.collapsed === collapsed && appearance.rootCollapsed === rootCollapsed) arriving.add(id);
      seen.add(id);
    }
    setAppearance({ tree, mode, collapsed, rootCollapsed, seen, arriving });
  }
  const entering = useMemo(
    () => (reduced ? undefined : FadeIn.duration(Math.round(140 * motionScale)).reduceMotion(ReduceMotion.System)),
    [reduced, motionScale],
  );
  const rows = mode === "tree" ? (rootCollapsed ? [] : flattenSubagentTree(tree, collapsed)) : Array.from(tree.nodes.values(), (node) => ({ node, depth: 0 }));
  const plan = chat.plan?.tasks;
  const planCounts = plan?.length ? taskCounts(plan) : undefined;
  const tasks = [...(plan ?? [])];
  let currentTask: string | undefined;
  while (tasks.length && !currentTask) {
    const task = tasks.shift()!;
    if (task.children?.length) tasks.unshift(...task.children);
    else if (task.status === "in_progress") currentTask = task.activeForm ?? task.title;
  }

  function scrollToAgent(id: string) {
    const y = rowPositions.current.get(id);
    const target = rowRefs.current.get(id);
    if (y === undefined || !target) return;
    onScrollTo(rowsTop.current + y);
    AccessibilityInfo.sendAccessibilityEvent(target, "focus");
    pendingReveal.current = null;
  }

  function queueReveal() {
    const request = pendingReveal.current;
    if (!request) return;
    // Native layout events update the announcement, container and row offsets before this frame runs.
    requestAnimationFrame(() => {
      if (pendingReveal.current === request) scrollToAgent(request.id);
    });
  }

  function reveal(status: Status) {
    const ordered = mode === "tree" ? flattenSubagentTree(tree, new Set()).map(({ node }) => node) : Array.from(tree.nodes.values());
    const matches = ordered.filter(({ agent }) => agent.status === status || (status === "running" && agent.status === "initializing"));
    if (!matches.length) return;
    const nextIndex = (matches.findIndex(({ agent }) => agent.id === focused) + 1) % matches.length;
    const next = matches[nextIndex]!.agent;
    const ancestors = mode === "tree" ? subagentAncestors(tree, next.id) : [];
    const hidden = mode === "tree" && (rootCollapsed || ancestors.some((id) => collapsed.has(id)));
    if (mode === "tree" && rootCollapsed) onRootCollapsed(false);
    if (hidden) {
      const expanded = new Set(collapsed);
      for (const id of ancestors) expanded.delete(id);
      onCollapsed(expanded);
    }
    pendingReveal.current = { id: next.id };
    onFocused(next.id);
    setAnnouncement((previous) => ({
      text: `${statusTitles[status]}: ${nextIndex + 1} of ${matches.length}. ${next.title}`,
      revision: previous.revision + 1,
      targetId: next.id,
      status: next.status,
    }));
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {statuses.map((status) => (
          <PillButton
            key={status}
            title={`${tree.counts[status]} ${statusTitles[status]}`}
            secondary
            disabled={!tree.counts[status]}
            onPress={() => reveal(status)}
            style={{ height: 44, paddingHorizontal: 12 }}
          />
        ))}
      </View>
      {showAnnouncement && (
        <Text key={announcement.revision} onLayout={queueReveal} accessibilityLiveRegion="polite" style={{ color: colors.ink3, fontSize: 13 }}>
          {announcement.text}
        </Text>
      )}
      {mode === "tree" && (
        <View style={{ padding: 12, gap: 6, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 14, backgroundColor: colors.surface }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <ProviderLogo provider={provider} size={18} />
            <Text accessibilityRole="header" style={{ flex: 1, color: colors.ink, fontWeight: "600", fontSize: 16 }}>
              Chat agent
            </Text>
            <Text style={{ color: colors.ink2, fontSize: 13 }}>{rootStatus}</Text>
            <IconButton
              label={`${rootCollapsed ? "Expand" : "Collapse"} Chat agent branch`}
              icon={rootCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
              size={44}
              onPress={() => onRootCollapsed(!rootCollapsed)}
            />
          </View>
          <Text selectable style={{ color: colors.ink3, fontSize: 13 }}>
            {[providerName(provider), rootModel].filter(Boolean).join(" · ")}
          </Text>
          {!!rootActivity && (
            <Text numberOfLines={2} style={{ color: colors.ink2, fontSize: 15 }}>
              {rootActivity}
            </Text>
          )}
          {!!planCounts && (
            <Text numberOfLines={2} style={{ color: colors.ink3, fontSize: 13 }}>
              {[`${planCounts.done} of ${planCounts.total} tasks done`, currentTask].filter(Boolean).join(" · ")}
            </Text>
          )}
          <Text style={{ color: colors.ink3, fontSize: 13 }}>
            {tree.roots.length} direct · {tree.counts.total} total subagents
          </Text>
        </View>
      )}
      <View
        onLayout={(event) => {
          rowsTop.current = event.nativeEvent.layout.y;
          queueReveal();
        }}
        style={{ gap: mode === "tree" ? 8 : 0 }}
      >
        {rows.map(({ node, depth }, index) => {
          const { agent, children, counts } = node;
          const action = advisorAction(agent);
          const isTree = mode === "tree";
          const closed = collapsed.has(agent.id);
          return (
            <Animated.View
              key={agent.id}
              entering={appearance.arriving.has(agent.id) ? entering : undefined}
              onLayout={(event) => {
                rowPositions.current.set(agent.id, event.nativeEvent.layout.y);
                if (pendingReveal.current?.id === agent.id) queueReveal();
              }}
              style={{
                marginLeft: isTree ? Math.min(depth, 3) * 12 : 0,
                paddingHorizontal: isTree ? 8 : 0,
                borderWidth: isTree ? 1 : 0,
                borderTopWidth: isTree ? 1 : index ? 1 : 0,
                borderColor: focused === agent.id ? colors.ink3 : colors.line,
                borderRadius: isTree ? 14 : 0,
                backgroundColor: focused === agent.id ? colors.hover : isTree ? colors.surface : "transparent",
              }}
            >
              {isTree && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 6 }}>
                  {children.length ? (
                    <IconButton
                      label={`${closed ? "Expand" : "Collapse"} ${agent.title}`}
                      icon={closed ? ArrowRight01Icon : ArrowDown01Icon}
                      size={44}
                      onPress={() => {
                        const next = new Set(collapsed);
                        if (closed) next.delete(agent.id);
                        else next.add(agent.id);
                        onCollapsed(next);
                      }}
                    />
                  ) : (
                    <View style={{ width: 8 }} />
                  )}
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text selectable numberOfLines={2} style={{ color: colors.ink3, fontSize: 12 }}>
                      {[providerName(agent.provider ?? provider), agent.model].filter(Boolean).join(" · ")}
                    </Text>
                    <Text
                      accessible
                      accessibilityLabel={`${agent.title}. ${subagentStatusLabel(agent.status)}. Level ${depth + 1}.`}
                      style={{ color: colors.ink2, fontSize: 12 }}
                    >
                      {subagentStatusLabel(agent.status)}
                      {depth > 3 ? ` · Level ${depth + 1}` : ""}
                    </Text>
                    {!!children.length && (
                      <Text numberOfLines={2} style={{ color: colors.ink3, fontSize: 12 }}>
                        {children.length} direct · {counts.total - 1} total ·{" "}
                        {counts.running - Number(agent.status === "running" || agent.status === "initializing")} running
                        {counts.waiting - Number(agent.status === "waiting") ? ` · ${counts.waiting - Number(agent.status === "waiting")} waiting` : ""}
                        {counts.failed - Number(agent.status === "failed") ? ` · ${counts.failed - Number(agent.status === "failed")} failed` : ""}
                      </Text>
                    )}
                  </View>
                </View>
              )}
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 4 }}>
                <SubagentRow
                  agent={agent}
                  provider={provider}
                  now={now}
                  rowRef={(row) => {
                    if (row) rowRefs.current.set(agent.id, row);
                    else rowRefs.current.delete(agent.id);
                  }}
                  onPress={() => {
                    onFocused(agent.id);
                    onOpen(agent.id);
                  }}
                />
                {action && (
                  <IconButton
                    label={`${action === "stop" ? "Stop" : "Retry"} ${agent.title}`}
                    icon={action === "stop" ? Cancel01Icon : RefreshIcon}
                    size={44}
                    disabled={disabled}
                    onPress={() => onControl(action, agent.id)}
                  />
                )}
              </View>
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}
