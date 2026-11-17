import { ScrollView, Text, View } from "react-native";
import type { AgentModels } from "@milagre/shared/model";
import type { BoardColumn, OrchestratorRole, OrchestratorTask } from "@milagre/shared/orchestrator";
import { lineHeight, radius, space, type } from "./design-tokens";
import { BOARD_TABS, columnItems, type BoardItem } from "./orchestrator-board";
import { DecidingCard, TaskCard, type Projects } from "./orchestrator-cards";
import { useTheme } from "./theme";
import { Chip } from "./ui";

const EMPTY: Record<BoardColumn, string> = {
  running: "Nothing running. Send something above.",
  needs: "Nothing needs you.",
  review: "No PRs waiting for review.",
  done: "Nothing finished yet.",
};

export function BoardTabs({ tab, counts, onTab }: { tab: BoardColumn; counts: Record<BoardColumn, number>; onTab: (tab: BoardColumn) => void }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      style={{ marginHorizontal: -space.gutter }}
      contentContainerStyle={{ gap: space.md, paddingHorizontal: space.gutter }}
    >
      {BOARD_TABS.map(({ id, label }) => (
        <Chip
          key={id}
          role="tab"
          label={`${label} ${counts[id]}`}
          accessibilityLabel={`${label}, ${counts[id]}`}
          selected={tab === id}
          onPress={() => onTab(id)}
          leading={
            id === "needs" && counts.needs > 0 ? <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.orange }} /> : undefined
          }
        />
      ))}
    </ScrollView>
  );
}

export function BoardList({
  tab,
  items,
  landing,
  projects,
  roles,
  models,
  color,
  now,
  accountOf,
  onLanded,
  onOpen,
}: {
  tab: BoardColumn;
  items: readonly BoardItem[];
  landing: ReadonlySet<string>;
  projects: Projects;
  roles: readonly OrchestratorRole[];
  models: AgentModels | null;
  color: string;
  now: number;
  accountOf: (task: OrchestratorTask) => string | null;
  onLanded: (task: OrchestratorTask) => void;
  onOpen: (item: BoardItem) => void;
}) {
  const { colors } = useTheme();
  const landingItems = tab === "running" ? items.filter((item) => landing.has(item.task.id) && item.task.state === "started") : [];
  const shown = columnItems(items, tab).filter((item) => !landingItems.includes(item));
  const list = [...landingItems, ...shown];
  if (!list.length)
    return (
      <Text style={{ color: colors.ink3, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, textAlign: "center", paddingVertical: space.xxl }}>
        {EMPTY[tab]}
      </Text>
    );
  return (
    <View style={{ gap: space.md }}>
      {list.map((item) =>
        item.kind === "deciding" || landingItems.includes(item) ? (
          <DecidingCard
            key={item.task.id}
            task={item.task}
            projects={projects}
            roles={roles}
            models={models}
            color={color}
            accountName={accountOf(item.task)}
            onDone={() => onLanded(item.task)}
          />
        ) : (
          <TaskCard key={item.task.id} item={item} projects={projects} roles={roles} models={models} now={now} onPress={() => onOpen(item)} />
        ),
      )}
    </View>
  );
}
