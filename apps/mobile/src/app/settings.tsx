import { Text, View } from "react-native";
import { Stack, router } from "expo-router";
import {
  BookOpen01Icon,
  BubbleChatIcon,
  Download04Icon,
  FlaskConicalIcon,
  FolderKeyIcon,
  Notification01Icon,
  PaintBoardIcon,
  Plug01Icon,
  SecurityCheckIcon,
  ServerIcon,
  Settings01Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { usePush } from "../push";
import { useAppUpdates } from "../update-sheet";
import { Icon, LinearLogo } from "../icons";
import { useSession } from "../session";
import { ProjectIcon } from "../project-icon";
import { ListRow, PageScroll, useStyles } from "../ui";

type SettingsPage =
  | "general"
  | "accounts"
  | "project-accounts"
  | "appearance"
  | "chat-display"
  | "notifications"
  | "linear"
  | "skills"
  | "mcp"
  | "local-mcp"
  | "experimental"
  | "privacy";

type IconData = Parameters<typeof Icon>[0]["icon"];

/** The pages in desktop's Settings order, with its icons. Devices and About live elsewhere on the phone: the Computers
 * screen pairs and lists computers, and App update closes the list. */
const PAGES: Array<{ page: SettingsPage; title: string; icon: IconData | "linear" }> = [
  { page: "general", title: "General", icon: Settings01Icon },
  { page: "accounts", title: "Accounts", icon: UserCircleIcon },
  { page: "project-accounts", title: "Project Accounts", icon: FolderKeyIcon },
  { page: "appearance", title: "Appearance", icon: PaintBoardIcon },
  { page: "chat-display", title: "Chat", icon: BubbleChatIcon },
  { page: "notifications", title: "Notifications", icon: Notification01Icon },
  { page: "linear", title: "Linear", icon: "linear" },
  { page: "skills", title: "Skills", icon: BookOpen01Icon },
  { page: "mcp", title: "MCP", icon: Plug01Icon },
  { page: "local-mcp", title: "Milagre MCP", icon: ServerIcon },
  { page: "experimental", title: "Experimental", icon: FlaskConicalIcon },
  { page: "privacy", title: "Privacy & AI", icon: SecurityCheckIcon },
];

export default function SettingsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Settings" }} />
      <PageScroll>
        <SettingsView onOpen={(page) => router.push(`/${page}`)} />
      </PageScroll>
    </>
  );
}

/** Settings pages stay on the native stack for the header and interactive back gesture. */
export function SettingsView({ onOpen }: { onOpen: (page: SettingsPage) => void }) {
  const styles = useStyles();
  const push = usePush();
  const updates = useAppUpdates();
  const session = useSession();
  const projects = session.recent.filter((project) => !project.link);
  const status = updates.state.status;
  const update =
    status === "disabled"
      ? "Not available in this build"
      : status === "checking"
        ? "Checking…"
        : status === "downloading"
          ? "Downloading…"
          : status === "ready"
            ? "Ready to install"
            : status === "up-to-date"
              ? "Up to date"
              : status === "restarting"
                ? "Restarting…"
                : status === "error" || status === "check-error"
                  ? "Could not check"
                  : "Check for updates";
  return (
    <View style={{ gap: 8 }}>
      <View style={[styles.card, { paddingVertical: 4, gap: 0 }]}>
        {PAGES.map((item) => (
          <View key={item.page}>
            <ListRow
              compact
              title={item.title}
              subtitle={item.page === "notifications" && push.state ? (push.state.enabled ? "On" : "Off") : undefined}
              leading={
                item.icon === "linear" ? (
                  <View style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}>
                    <LinearLogo size={16} tone="ink" />
                  </View>
                ) : (
                  <Icon icon={item.icon} tone="ink" size={20} />
                )
              }
              onPress={() => onOpen(item.page)}
            />
            <View style={styles.separator} />
          </View>
        ))}
        {/* Checks now and shows the update sheet, which follows the check to Up to date or Update now. */}
        <ListRow
          compact
          title="App update"
          subtitle={update}
          disabled={status === "disabled"}
          leading={<Icon icon={Download04Icon} tone="ink" size={20} />}
          onPress={() => {
            void updates.check(true);
            router.push("/update-sheet");
          }}
        />
      </View>
      {/* The connected computer's Projects; each opens its own settings. */}
      {session.client && projects.length > 0 && (
        <>
          <Text style={[styles.label, { marginTop: 16 }]}>Projects</Text>
          <View style={[styles.card, { paddingVertical: 4, gap: 0 }]}>
            {projects.map((project, index) => (
              <View key={project.path}>
                {index > 0 && <View style={styles.separator} />}
                <ListRow
                  compact
                  title={project.name || project.path.split("/").filter(Boolean).at(-1) || project.path}
                  leading={<ProjectIcon client={session.client} path={project.path} size={24} />}
                  onPress={() => router.push({ pathname: "/project-settings", params: { path: project.path, name: project.name ?? "" } })}
                />
              </View>
            ))}
          </View>
        </>
      )}
    </View>
  );
}
