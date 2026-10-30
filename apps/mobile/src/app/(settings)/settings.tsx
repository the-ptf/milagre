import { useCallback, useState } from "react";
import { Alert, Linking, Platform, Pressable, Text, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import {
  Archive02Icon,
  BookOpen01Icon,
  BubbleChatIcon,
  BrowserIcon,
  Cancel01Icon,
  ComputerIcon,
  ConnectIcon,
  Download04Icon,
  FlaskConicalIcon,
  FolderKeyIcon,
  HelpCircleIcon,
  Notification01Icon,
  PaintBoardIcon,
  Plug01Icon,
  RepeatIcon,
  SecurityCheckIcon,
  Settings01Icon,
  UserCircleIcon,
  KeyboardIcon,
} from "@hugeicons/core-free-icons";
import { chatListLabel } from "@milagre/shared/chat-display";
import { PRIVACY_URL, SUPPORT_URL } from "@milagre/shared/site-links";
import { usePush } from "../../push";
import { useAppUpdates } from "../../update-sheet";
import { Icon, type IconData } from "../../icons";
import { MilagreMark } from "../../milagre-mark";
import { useSession } from "../../session";
import { ProjectIcon } from "../../project-icon";
import { useInternalBrowser } from "../../browser-setting";
import { useChatList } from "../../chat-display-setting";
import { useArchivedCount } from "../../all-computers";
import { useComputerStatus } from "../../use-computer-status";
import { useRoutines, useRoutinesAvailable } from "../../use-routines";
import { appVersionLine } from "../../app-version";
import { Group, Row } from "../../settings-list";
import { useTheme } from "../../theme";
import { HeaderButton, PageScroll, useStyles } from "../../ui";

type SettingsPage =
  | "computers"
  | "routines"
  | "general"
  | "browser-settings"
  | "accounts"
  | "project-accounts"
  | "appearance"
  | "chat-display"
  | "keybindings"
  | "archived"
  | "notifications"
  | "connections"
  | "skills"
  | "mcp"
  | "local-mcp"
  | "experimental";

const MODE_LABEL = { system: "System", light: "Light", dark: "Dark" } as const;

export default function SettingsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Settings" }} />
      {/* Settings is the first page of its sheet, so Back here closes the sheet. */}
      <Stack.Toolbar placement="right">
        {Platform.OS === "ios" ? (
          <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close Settings" onPress={() => router.back()} />
        ) : (
          <Stack.Toolbar.View>
            <HeaderButton label="Close Settings" icon={Cancel01Icon} onPress={() => router.back()} />
          </Stack.Toolbar.View>
        )}
      </Stack.Toolbar>
      <PageScroll>
        <SettingsView
          onOpen={(page) => {
            // Routines is a full page of the app, not a page of the sheet: close the sheet, then open it over the Chat.
            if (page === "routines") router.back();
            router.push(`/${page}`);
          }}
        />
      </PageScroll>
    </>
  );
}

/** A square entry point at the top of Settings: icon, title and a one-line state. */
function Tile({
  title,
  icon,
  value,
  dot,
  disabled = false,
  onPress,
}: {
  title: string;
  icon: IconData;
  value?: string;
  /** A status dot before the value. */
  dot?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${title}. ${value}` : title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { flex: 1, minHeight: 101, gap: 6, padding: 14, borderRadius: 18, opacity: disabled ? 0.4 : pressed ? 0.5 : 1 }]}
    >
      <Icon icon={icon} tone="ink" size={22} />
      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 16, fontWeight: "600" }}>
        {title}
      </Text>
      {value ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          {dot ? <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: dot }} /> : null}
          <Text numberOfLines={1} style={{ flex: 1, color: colors.ink3, fontSize: 13 }}>
            {value}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Opens a page of Milagre's site in the browser. */
function openSite(url: string) {
  void Linking.openURL(url).catch(() => Alert.alert("Could not open this page", `Visit ${url} in your browser.`));
}

/** The first page of the Settings sheet; each row opens a page inside the same sheet. */
export function SettingsView({ onOpen }: { onOpen: (page: SettingsPage) => void }) {
  const { colors, settings: theme } = useTheme();
  const push = usePush();
  const updates = useAppUpdates();
  const session = useSession();
  const [internalBrowser] = useInternalBrowser();
  const [chatList] = useChatList();
  const archived = useArchivedCount();
  const client = session.client;
  const host = client ? session.hosts.find((saved) => saved.id === client.url) : undefined;
  const macName = host?.name || session.hostName || "Your Mac";
  const projects = session.recent.filter((project) => !project.link);
  // Connections only lists what the phone can change: a connected Mac that answers for Linear. Re-read on focus, since
  // the Mac can turn it on or connect while the phone is elsewhere; an older Mac answers null and keeps it hidden.
  const [linear, setLinear] = useState<{ client: typeof client; enabled: boolean } | null>(null);
  useFocusEffect(
    useCallback(() => {
      setLinear(null);
      if (!client) return;
      let live = true;
      client.call<{ enabled: boolean } | null>("linear:enabled:read", []).then(
        (value) => live && setLinear(value ? { client, enabled: value.enabled === true } : null),
        () => live && setLinear(null),
      );
      return () => {
        live = false;
      };
    }, [client]),
  );
  const status = updates.state.status;
  const update =
    status === "disabled"
      ? "Not available"
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
                  : "Check now";
  const reachability = useComputerStatus(session.hosts);
  const states = Object.values(reachability);
  const online = states.filter((state) => state === "online").length;
  const offline = states.filter((state) => state === "offline").length;
  const computersValue = !states.length
    ? "None paired"
    : online + offline === 0
      ? "Checking…"
      : online === 0
        ? "Offline"
        : offline === 0
          ? `${online} online`
          : `${online} online · ${offline} offline`;
  // Routines: the Mac's switch gates the tile; the count comes from the same store the Routines page reads.
  const routinesAvailable = useRoutinesAvailable(client);
  const routines = useRoutines(routinesAvailable ? client : null);
  const routinesOn = routines.routines.filter((routine) => routine.enabled).length;
  const routinesValue = !client ? "No computer connected" : !routinesAvailable ? "Update your Mac" : routines.loading ? undefined : `${routinesOn} on`;
  return (
    <View style={{ gap: 28 }}>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Tile
          title="Computers"
          icon={ComputerIcon}
          value={computersValue}
          dot={online > 0 ? colors.green : colors.lineStrong}
          onPress={() => onOpen("computers")}
        />
        <Tile title="Routines" icon={RepeatIcon} value={routinesValue} disabled={!routinesAvailable} onPress={() => onOpen("routines")} />
      </View>
      <Group title="This device" footer="Saved on this device. Your other devices keep their own.">
        <Row
          title="Notifications"
          icon={Notification01Icon}
          value={push.state ? (push.state.enabled ? "On" : "Off") : undefined}
          onPress={() => onOpen("notifications")}
        />
        <Row title="Appearance" icon={PaintBoardIcon} value={MODE_LABEL[theme.mode]} onPress={() => onOpen("appearance")} />
        <Row title="Browser" icon={BrowserIcon} value={internalBrowser ? "Milagre" : "Default browser"} onPress={() => onOpen("browser-settings")} />
        <Row title="Chat" icon={BubbleChatIcon} value={chatListLabel(chatList)} onPress={() => onOpen("chat-display")} />
        <Row title="Archived Chats" icon={Archive02Icon} value={archived === null ? undefined : String(archived)} onPress={() => onOpen("archived")} />
        <Row title="Experimental" icon={FlaskConicalIcon} onPress={() => onOpen("experimental")} />
      </Group>
      {/* The connected Mac's settings; without one there is nothing here the phone can change, so the group is gone. */}
      {client ? (
        <Group title={macName} footer="Changes here apply to the Mac and every device paired with it.">
          <Row title="General" icon={Settings01Icon} onPress={() => onOpen("general")} />
          <Row title="Accounts" icon={UserCircleIcon} onPress={() => onOpen("accounts")} />
          <Row title="Project Accounts" icon={FolderKeyIcon} onPress={() => onOpen("project-accounts")} />
          {linear?.client === client ? (
            <Row title="Connections" icon={ConnectIcon} value={linear.enabled ? "Linear" : "Off"} onPress={() => onOpen("connections")} />
          ) : null}
          <Row title="Skills" icon={BookOpen01Icon} onPress={() => onOpen("skills")} />
          <Row title="MCP" icon={Plug01Icon} onPress={() => onOpen("mcp")} />
          <Row title="Milagre" leading={<MilagreMark />} onPress={() => onOpen("local-mcp")} />
          {/* The Mac's keybindings.json, which an iPad's hardware keyboard runs too. */}
          {Platform.OS === "ios" && Platform.isPad ? <Row title="Keybindings" icon={KeyboardIcon} onPress={() => onOpen("keybindings")} /> : null}
        </Group>
      ) : null}
      {/* The connected computer's Projects; each opens its own settings. */}
      {client && projects.length > 0 ? (
        <Group title="Projects">
          {projects.map((project) => (
            <Row
              key={project.path}
              title={project.name || project.path.split("/").findLast(Boolean) || project.path}
              leading={<ProjectIcon client={client} path={project.path} size={22} />}
              onPress={() => router.push({ pathname: "/project-settings", params: { path: project.path, name: project.name ?? "" } })}
            />
          ))}
        </Group>
      ) : null}
      <Group title="About">
        <Row title="Privacy policy" icon={SecurityCheckIcon} onPress={() => openSite(PRIVACY_URL)} />
        <Row title="Support" icon={HelpCircleIcon} onPress={() => openSite(SUPPORT_URL)} />
        {/* Checks now and shows the update sheet, which follows the check to Up to date or Update now. */}
        <Row
          title="App update"
          icon={Download04Icon}
          value={update}
          disabled={status === "disabled"}
          onPress={() => {
            void updates.check(true);
            router.push("/update-sheet");
          }}
        />
      </Group>
      {/* Version · build · runtime, and the running update's commit: what to quote when reporting a bug. */}
      <Text selectable style={{ color: colors.ink2, fontSize: 13, textAlign: "center", marginTop: -8 }}>
        {appVersionLine()}
      </Text>
    </View>
  );
}
