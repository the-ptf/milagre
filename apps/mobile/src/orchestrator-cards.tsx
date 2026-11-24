import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Alert02Icon, CheckmarkCircle02Icon, GitMergeIcon, GitPullRequestIcon, HourglassIcon, Image01Icon } from "@hugeicons/core-free-icons";
import { roleById, type OrchestratorRole, type OrchestratorTask } from "@milagre/shared/orchestrator";
import type { AgentModels } from "@milagre/shared/model";
import { PR_TONE } from "@milagre/shared/pr-blockers";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon, ProviderLogo, SpinnerRing } from "./icons";
import { modelAndEffort, projectName, relativeAge, shownPullRequestMark, type BoardItem } from "./orchestrator-board";
import { SplitPicker } from "./orchestrator-split-picker";
import { PR_ICONS } from "./pr-look";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { pressStyle, Tag, useStyles } from "./ui";

export type Projects = readonly { path: string; name?: string }[];

export function TaskMark({ item }: { item: BoardItem }) {
  const { colors } = useTheme();
  if (item.kind === "deciding" || item.kind === "loading" || item.kind === "remote") return <SpinnerRing size={16} />;
  if (item.kind === "failed" || item.mark === "failed") return <Icon icon={Alert02Icon} tone="red" size={16} />;
  if (item.column === "needs")
    return (
      <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.orange }} />
      </View>
    );
  const pr = shownPullRequestMark(item);
  if (pr)
    return (
      <View accessible accessibilityRole="image" accessibilityLabel={pr.label}>
        <Icon icon={PR_ICONS[pr.icon]} tone={PR_TONE[pr.tone].icon} size={16} />
      </View>
    );
  if (item.column === "review" && item.pullRequest === "open") return <Icon icon={GitPullRequestIcon} tone="green" size={16} />;
  if (item.column === "review") return <Icon icon={CheckmarkCircle02Icon} tone="ink3" size={16} />;
  if (item.column === "done")
    return item.pullRequest === "merged" ? <Icon icon={GitMergeIcon} tone="purple" size={16} /> : <Icon icon={CheckmarkCircle02Icon} tone="ink3" size={16} />;
  if (item.mark === "running" || item.mark === "background") return <SpinnerRing size={16} />;
  if (item.mark === "unread")
    return (
      <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.accent }} />
      </View>
    );
  return <Icon icon={CheckmarkCircle02Icon} tone="ink3" size={16} />;
}

function Meta({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
      {children}
    </Text>
  );
}

export function TaskCard({
  item,
  projects,
  roles,
  models,
  now,
  onPress,
}: {
  item: BoardItem;
  projects: Projects;
  roles: readonly OrchestratorRole[];
  models: AgentModels | null;
  now: number;
  onPress: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { hostName } = useSession();
  const { task } = item;
  const role = roles.find((entry) => entry.id === task.role)?.name ?? task.role;
  const needsTone = item.kind === "failed" ? colors.redInk : colors.orangeInk;
  const pr = shownPullRequestMark(item);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${task.title}. ${pr ? `${pr.label}. ` : ""}${item.detail}${task.images ? `. ${task.images === 1 ? "1 photo" : `${task.images} photos`}` : ""}${item.countdown ? `. Archived in ${item.countdown}` : ""}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { gap: space.sm, paddingVertical: space.lg }, pressStyle({ pressed, kind: "row" })]}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
        <View style={{ paddingTop: space.xxs }}>
          <TaskMark item={item} />
        </View>
        <Text style={{ flex: 1, color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600" }}>{task.title}</Text>
        {task.images > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xxs }}>
            <Icon icon={Image01Icon} tone="ink3" size={12} />
            <Text style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.callout }}>{task.images}</Text>
          </View>
        ) : null}
        {item.countdown ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xxs }}>
            <Icon icon={HourglassIcon} tone="ink3" size={12} />
            <Text style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.callout, fontWeight: "500", fontVariant: ["tabular-nums"] }}>
              {item.countdown}
            </Text>
          </View>
        ) : (
          <Text style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.callout }}>{relativeAge(task.createdAt, now)}</Text>
        )}
      </View>
      {item.detail ? (
        <Text
          numberOfLines={2}
          style={{
            color: item.column === "needs" ? needsTone : colors.ink2,
            fontSize: type.footnote,
            lineHeight: lineHeight.footnote,
          }}
        >
          {item.detail}
        </Text>
      ) : null}
      {task.state === "started" && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {task.provider ? <ProviderLogo provider={task.provider} size={12} /> : null}
          <View style={{ flex: 1 }}>
            <Meta>
              {`${task.computer ?? (hostName || "This computer")} · `}
              {projectName(task.projectPath, projects)} · {modelAndEffort(task.provider, task.model, task.effort, models)} · {role}
            </Meta>
          </View>
          {item.inSidebar ? <Tag label="In sidebar" /> : null}
        </View>
      )}
    </Pressable>
  );
}

/** A task the host is routing; once routed, the mascot splits up and drops each pick as a chip, then `onDone` fires. */
export function DecidingCard({
  task,
  projects,
  roles,
  models,
  color,
  accountName,
  onDone,
}: {
  task: OrchestratorTask;
  projects: Projects;
  roles: readonly OrchestratorRole[];
  models: AgentModels | null;
  color: string;
  accountName: string | null;
  onDone?: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [merged, setMerged] = useState(false);
  const routed = task.state !== "routing";
  const chips = useMemo(
    () => [
      projectName(task.projectPath, projects),
      modelAndEffort(task.provider, task.model, task.effort, models),
      roleById(roles, task.role)?.name ?? task.role,
      accountName ?? task.reason.account ?? "Project's account",
    ],
    [task, projects, models, roles, accountName],
  );
  return (
    <View accessibilityLabel={`Routing ${task.title}`} accessibilityLiveRegion="polite" style={[styles.card, { gap: space.sm, paddingVertical: space.lg }]}>
      <SplitPicker
        title={task.title}
        chips={chips}
        picked={routed}
        color={color}
        onDone={() => {
          setMerged(true);
          onDone?.();
        }}
      />
      <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
        {merged ? "Starting the Chat…" : "Picking the Project, model and account…"}
      </Text>
    </View>
  );
}
