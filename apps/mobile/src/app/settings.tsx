import { useCallback, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import {
  ArrowRight01Icon,
  BookOpen01Icon,
  BubbleChatIcon,
  ComputerIcon,
  ConnectIcon,
  Download04Icon,
  FlaskConicalIcon,
  FolderKeyIcon,
  LaptopIcon,
  Notification01Icon,
  PaintBoardIcon,
  Plug01Icon,
  SecurityCheckIcon,
  ServerIcon,
  Settings01Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { TOOL_CALL_DISPLAYS } from "@milagre/shared/chat-display";
import { usePush } from "../push";
import { useAppUpdates } from "../update-sheet";
import { Icon, type IconData } from "../icons";
import { useSession } from "../session";
import { ProjectIcon } from "../project-icon";
import { lanRoutes } from "../routes-native";
import { useToolCallDisplay } from "../chat-display-setting";
import { appVersionLine } from "../app-version";
import { useTheme } from "../theme";
import { PageScroll, useStyles } from "../ui";

type SettingsPage =
  | "general"
  | "accounts"
  | "project-accounts"
  | "appearance"
  | "chat-display"
  | "notifications"
  | "connections"
  | "skills"
  | "mcp"
  | "local-mcp"
  | "experimental"
  | "privacy";

const MODE_LABEL = { system: "System", light: "Light", dark: "Dark" } as const;

export default function SettingsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Settings", headerLargeTitle: true, headerLargeTitleStyle: { fontWeight: "700" } }} />
      <PageScroll>
        <SettingsView onOpen={(page) => router.push(`/${page}`)} />
      </PageScroll>
    </>
  );
}

/** A grouped list: its header, the rows in one card with inset separators, and a note under it. */
function Group({ title, footer, children }: { title?: string; footer?: string; children: ReactNode[] }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const rows = children.filter(Boolean);
  return (
    <View style={{ gap: 8 }}>
      {title ? (
        <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 13, paddingHorizontal: 16 }}>
          {title}
        </Text>
      ) : null}
      <View style={[styles.card, { paddingVertical: 0, paddingHorizontal: 16, gap: 0 }]}>
        {rows.map((row, index) => (
          <View key={index}>
            {index > 0 && <View style={[styles.separator, { marginLeft: 36 }]} />}
            {row}
          </View>
        ))}
      </View>
      {footer ? <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, paddingHorizontal: 16 }}>{footer}</Text> : null}
    </View>
  );
}

/** One Settings row: icon, title, the current value when it's known without asking the Mac, and a chevron. */
function Row({
  title,
  icon,
  leading,
  value,
  disabled = false,
  onPress,
}: {
  title: string;
  icon?: IconData;
  leading?: ReactNode;
  value?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${title}. ${value}` : title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        minHeight: 52,
        opacity: disabled ? 0.4 : pressed ? 0.5 : 1,
      })}
    >
      {leading ?? (icon ? <Icon icon={icon} tone="ink" size={22} /> : null)}
      <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 17 }}>
        {title}
      </Text>
      {value ? (
        <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 17, maxWidth: "45%" }}>
          {value}
        </Text>
      ) : null}
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </Pressable>
  );
}

/** Settings pages stay on the native stack for the header and interactive back gesture. */
export function SettingsView({ onOpen }: { onOpen: (page: SettingsPage) => void }) {
  const styles = useStyles();
  const { colors, settings: theme } = useTheme();
  const push = usePush();
  const updates = useAppUpdates();
  const session = useSession();
  const [toolCallDisplay] = useToolCallDisplay();
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
  const route = host ? (lanRoutes.kind(host.id) === "lan" ? "Local network" : host.relay ? "Relay" : host.address.replace(/^https?:\/\//, "")) : "";
  return (
    <View style={{ gap: 28 }}>
      {/* Which computer the Mac settings below belong to; tapping it goes back to the list to switch or pair. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={client ? `${macName}. Connected, ${route}` : session.hosts.length ? "Choose a computer" : "Pair a computer"}
        onPress={() => (client || session.hosts.length ? router.navigate("/") : router.push("/add-computer"))}
        style={({ pressed }) => [styles.card, { flexDirection: "row", alignItems: "center", gap: 12, opacity: pressed ? 0.5 : 1 }]}
      >
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            borderCurve: "continuous",
            backgroundColor: colors.field,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon icon={client && /studio|mini|imac/i.test(macName) ? ComputerIcon : LaptopIcon} tone="ink" size={22} />
          {client ? (
            <View
              style={{
                position: "absolute",
                right: -2,
                bottom: -2,
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: colors.green,
                borderWidth: 2,
                borderColor: colors.surface,
              }}
            />
          ) : null}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
            {client ? macName : session.hosts.length ? "No computer connected" : "Pair a computer"}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 15 }}>
            {client ? `Connected · ${route}` : session.hosts.length ? "Choose one to change its settings" : "Scan the code in Milagre on your Mac"}
          </Text>
        </View>
        <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
      </Pressable>
      <Group title="This iPhone" footer="Saved on this phone. Your other devices keep their own.">
        <Row
          title="Notifications"
          icon={Notification01Icon}
          value={push.state ? (push.state.enabled ? "On" : "Off") : undefined}
          onPress={() => onOpen("notifications")}
        />
        <Row title="Appearance" icon={PaintBoardIcon} value={MODE_LABEL[theme.mode]} onPress={() => onOpen("appearance")} />
        <Row
          title="Chat"
          icon={BubbleChatIcon}
          value={TOOL_CALL_DISPLAYS.find((display) => display.id === toolCallDisplay)?.label}
          onPress={() => onOpen("chat-display")}
        />
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
          <Row title="Milagre MCP" icon={ServerIcon} onPress={() => onOpen("local-mcp")} />
        </Group>
      ) : null}
      {/* The connected computer's Projects; each opens its own settings. */}
      {client && projects.length > 0 ? (
        <Group title="Projects">
          {projects.map((project) => (
            <Row
              key={project.path}
              title={project.name || project.path.split("/").filter(Boolean).at(-1) || project.path}
              leading={<ProjectIcon client={client} path={project.path} size={22} />}
              onPress={() => router.push({ pathname: "/project-settings", params: { path: project.path, name: project.name ?? "" } })}
            />
          ))}
        </Group>
      ) : null}
      <Group title="About">
        <Row title="Privacy & AI" icon={SecurityCheckIcon} onPress={() => onOpen("privacy")} />
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
