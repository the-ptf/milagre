import { useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { ArrowMoveUpRightIcon, ShuffleIcon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { activeRoles, type OrchestratorSettings, type OrchestratorTask } from "@milagre/shared/orchestrator";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { allComputers } from "./all-computers";
import { accountName, openTaskChat, taskChatKey, taskHost, useAccountNames } from "./orchestrator-actions";
import { BOARD_TABS, modelAndEffort, projectName, type BoardItem } from "./orchestrator-board";
import { TaskMark } from "./orchestrator-cards";
import type { OrchestratorStore } from "./orchestrator-store";
import { confirm } from "./confirm-store";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { CheckRow, ErrorNotice, Group, ListRow, PageScroll, PillButton, PullDown, SectionLabel, useSheetBottomInset } from "./ui";
import { useOrchestrator } from "./use-orchestrator";
import { useOrchestratorBoard } from "./use-orchestrator-board";
import { useOrchestratorProjects } from "./use-orchestrator-lists";

const DELETE_MESSAGE = "This stops its agent and deletes its Chat. Its Worktree and branch stay.";

type Projects = readonly { path: string; name?: string }[];

function Routed({ task, projects, settings }: { task: OrchestratorTask; projects: Projects; settings: OrchestratorSettings }) {
  const session = useSession();
  const accounts = useAccountNames(session.client);
  const role = settings.roles.find((entry) => entry.id === task.role)?.name ?? task.role;
  const row = (title: string, value: string, why?: string | null) => (
    <ListRow key={title} title={title} value={value} subtitle={why ?? undefined} subtitleLines={2} chevron={false} />
  );
  return (
    <Group title="How I routed it" inset={0}>
      {row("Project", projectName(task.projectPath, projects), task.reason.project)}
      {row("Role", role, task.reason.role)}
      {row("Model", modelAndEffort(task.provider, task.model, task.effort, session.models))}
      {row("Account", accountName(accounts, task) ?? "Project's account", task.reason.account)}
      {row("Computer", task.computer ?? (session.hostName || "This computer"), task.reason.computer)}
    </Group>
  );
}

function RerouteMenu({
  task,
  projects,
  settings,
  onPick,
}: {
  task: OrchestratorTask;
  projects: Projects;
  settings: OrchestratorSettings;
  onPick: (id: string) => void;
}) {
  const routable = projects.filter((project) => settings.projects[project.path]?.included !== false);
  return (
    <PullDown
      label="Re-route"
      sections={[
        { items: [{ id: "again", title: "Route it again", systemImage: "shuffle" }] },
        {
          items: [
            {
              id: "projects",
              title: "Another Project",
              systemImage: "folder",
              submenu: routable.map((project) => ({
                id: `project:${project.path}`,
                title: projectName(project.path, projects),
                checked: project.path === task.projectPath,
              })),
            },
            {
              id: "roles",
              title: "Another role",
              systemImage: "person.crop.circle",
              submenu: activeRoles(settings.roles).map((role) => ({ id: `role:${role.id}`, title: role.name, checked: role.id === task.role })),
            },
          ],
        },
      ]}
      onSelect={onPick}
    >
      <MenuPill icon={ShuffleIcon} title="Re-route" />
    </PullDown>
  );
}

function MenuPill({ icon, title }: { icon: typeof ShuffleIcon; title: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        minHeight: 52,
        borderRadius: radius.full,
        borderCurve: "continuous",
        backgroundColor: colors.field,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.md,
      }}
    >
      <Icon icon={icon} tone="ink" size={18} />
      <Text style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: "600" }}>{title}</Text>
    </View>
  );
}

function MoveMenu({ item, onPick }: { item: BoardItem; onPick: (column: string) => void }) {
  return (
    <PullDown
      label="Move to"
      sections={[{ items: BOARD_TABS.map((tab) => ({ id: tab.id, title: tab.label, checked: tab.id === item.column })) }]}
      onSelect={(id) => id !== item.column && onPick(id)}
    >
      <MenuPill icon={ArrowMoveUpRightIcon} title="Move to" />
    </PullDown>
  );
}

function Actions({ item, store, settings, projects }: { item: BoardItem; store: OrchestratorStore; settings: OrchestratorSettings; projects: Projects }) {
  const session = useSession();
  const [error, setError] = useState("");
  const { task } = item;
  const act = (method: string, args: unknown[], close = false) => {
    setError("");
    if (close) router.back();
    store.act(method, args, close ? { optimisticDrop: task.id } : {}).catch((failure: Error) => setError(failure.message || "That didn't work. Try again."));
  };
  const reroute = (id: string) => {
    if (id === "again") act("orchestrator:task:reroute", [task.id, {}]);
    else if (id.startsWith("project:")) act("orchestrator:task:reroute", [task.id, { projectPath: id.slice("project:".length) }]);
    else if (id.startsWith("role:")) act("orchestrator:task:reroute", [task.id, { role: id.slice("role:".length) }]);
  };
  const key = taskChatKey(task);
  const live = item.mark === "running" || item.mark === "waiting" || item.mark === "question" || item.mark === "background";
  return (
    <View style={{ gap: space.md }}>
      {error ? <ErrorNotice message={error} /> : null}
      {item.kind === "chat" || item.kind === "loading" || item.kind === "remote" ? (
        <>
          <PillButton
            title="Open Subchat"
            size="large"
            onPress={() => openTaskChat(task, session, { fromSheet: true }).catch((failure: Error) => setError(failure.message))}
          />
          <PillButton
            title={item.inSidebar ? "Back to board only" : "Move to sidebar"}
            icon={SidebarLeftIcon}
            size="large"
            variant="tinted"
            onPress={() => act("orchestrator:task:sidebar", [task.id, !item.inSidebar])}
          />
        </>
      ) : null}
      {item.kind === "chat" || item.kind === "remote" ? <MoveMenu item={item} onPick={(column) => act("orchestrator:task:move", [task.id, column])} /> : null}
      {item.kind !== "deciding" && item.column !== "done" ? <RerouteMenu task={task} projects={projects} settings={settings} onPick={reroute} /> : null}
      {live && key ? (
        <PillButton
          title="Stop"
          size="large"
          variant="tinted"
          destructive
          onPress={() => {
            const at = taskHost(task, session.client?.url, allComputers.views());
            const client = at === session.client?.url ? session.client : at ? allComputers.clientFor(at) : null;
            client?.call("agent:interrupt", [key]).catch((failure: Error) => setError(failure.message));
          }}
        />
      ) : null}
      {item.kind === "deciding" ? (
        <PillButton title="Cancel" size="large" variant="tinted" destructive onPress={() => act("orchestrator:task:undo", [task.id], true)} />
      ) : null}
      {item.kind === "failed" || item.kind === "needs-project" || item.column === "done" ? (
        <PillButton title="Remove from board" size="large" variant="plain" muted onPress={() => act("orchestrator:task:dismiss", [task.id], true)} />
      ) : null}
      {item.kind === "chat" || item.kind === "loading" || item.kind === "remote" ? (
        <PillButton
          title="Delete task"
          size="large"
          variant="plain"
          destructive
          onPress={async () => {
            if (await confirm(`Delete ${task.title}?`, DELETE_MESSAGE, "Delete")) act("orchestrator:task:delete", [task.id], true);
          }}
        />
      ) : null}
    </View>
  );
}

function ProjectPicker({
  task,
  store,
  settings,
  projects,
}: {
  task: OrchestratorTask;
  store: OrchestratorStore;
  settings: OrchestratorSettings;
  projects: Projects;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState("");
  const routable = projects.filter((project) => settings.projects[project.path]?.included !== false);
  return (
    <View style={{ gap: space.md }}>
      <Group title="Pick a Project" inset={0}>
        {routable.map((project) => (
          <CheckRow
            key={project.path}
            title={projectName(project.path, projects)}
            checked={picked === project.path}
            disabled={picked !== null}
            onPress={() => {
              setPicked(project.path);
              setError("");
              store.act("orchestrator:task:project", [task.id, project.path]).then(
                () => router.back(),
                (failure: Error) => {
                  setPicked(null);
                  setError(failure.message || "Couldn't start it there.");
                },
              );
            }}
          />
        ))}
      </Group>
      {error ? <ErrorNotice message={error} /> : null}
    </View>
  );
}

export function OrchestratorTaskSheet({ taskId }: { taskId: string }) {
  const { colors } = useTheme();
  const session = useSession();
  const bottom = useSheetBottomInset();
  const { snapshot, store } = useOrchestrator(session.client);
  const listed = useOrchestratorProjects(session.client);
  const { items } = useOrchestratorBoard(snapshot?.tasks ?? []);
  const item = items.find((entry) => entry.task.id === taskId);
  if (!item || !snapshot || !store)
    return (
      <View style={{ padding: space.gutter, paddingBottom: bottom }}>
        <Text style={{ color: colors.ink3, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, textAlign: "center" }}>
          {snapshot ? "This task is no longer on the board." : "Loading…"}
        </Text>
      </View>
    );
  const { task } = item;
  const projects = listed ?? session.recent;
  return (
    <PageScroll contentContainerStyle={{ gap: space.xl, paddingTop: space.xxl, paddingBottom: bottom }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
        <View style={{ paddingTop: space.xs }}>
          <TaskMark item={item} />
        </View>
        <Text accessibilityRole="header" style={{ flex: 1, color: colors.ink, fontSize: type.title3, lineHeight: lineHeight.title3, fontWeight: "600" }}>
          {task.title}
        </Text>
      </View>
      <View style={{ backgroundColor: colors.canvas, borderRadius: radius.control, borderCurve: "continuous", padding: space.lg }}>
        <Text selectable style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
          {task.prompt}
        </Text>
      </View>
      {item.detail && item.kind !== "deciding" ? (
        <View style={{ gap: space.sm }}>
          <SectionLabel>{item.kind === "failed" ? "What went wrong" : "Now"}</SectionLabel>
          <Text
            style={{
              color: item.kind === "failed" ? colors.redInk : item.column === "needs" ? colors.orangeInk : colors.ink2,
              fontSize: type.subheadline,
              lineHeight: lineHeight.subheadline,
              paddingHorizontal: space.xl,
            }}
          >
            {item.detail}
          </Text>
        </View>
      ) : null}
      {task.state === "started" ? <Routed task={task} projects={projects} settings={snapshot.settings} /> : null}
      {task.state === "needs-project" ? <ProjectPicker task={task} store={store} settings={snapshot.settings} projects={projects} /> : null}
      <Actions item={item} store={store} settings={snapshot.settings} projects={projects} />
    </PageScroll>
  );
}
