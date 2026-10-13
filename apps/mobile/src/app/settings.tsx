import { useCallback, useState } from "react";
import { MAIN_SYNC_HINT, MAIN_SYNC_TITLE } from "@milagre/shared/main-sync";
import { Text, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import {
  ChartBarLineIcon,
  Download04Icon,
  MagicWand01Icon,
  Notification01Icon,
  PaintBoardIcon,
  PlugSocketIcon,
  TestTube01Icon,
  SecurityCheckIcon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { usePush } from "../push";
import { useAppUpdates } from "../update-sheet";
import { Icon } from "../icons";
import { useSession } from "../session";
import { ProjectIcon } from "../project-icon";
import { ErrorNotice, ListRow, PageScroll, Toggle, useStyles } from "../ui";
import { useAttentionButton } from "../attention";

type SettingsPage = "privacy" | "notifications" | "usage" | "accounts" | "project-accounts" | "skills" | "mcp" | "appearance" | "experimental";

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
  const [attentionButton, setAttentionButton] = useAttentionButton();
  const updates = useAppUpdates();
  const session = useSession();
  const projects = session.recent.filter((project) => !project.link);
  // The computer's global default for main branch sync; null until it answers (an older Mac never does). Re-read on
  // focus: it may have changed on the Mac while the phone was on another screen.
  const [syncMain, setSyncMain] = useState<boolean | null>(null);
  const [syncMainError, setSyncMainError] = useState("");
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      if (!client) return;
      let live = true;
      client.call<{ syncMain: boolean }>("main-sync:default:read", []).then(
        (value) => live && setSyncMain(value.syncMain),
        () => live && setSyncMain(null),
      );
      return () => {
        live = false;
      };
    }, [session.client]),
  );
  async function changeSyncMain(next: boolean) {
    const client = session.client;
    if (!client) return;
    setSyncMainError("");
    setSyncMain(next);
    try {
      setSyncMain((await client.call<{ syncMain: boolean }>("main-sync:default:save", [next])).syncMain);
    } catch (failure) {
      setSyncMain(!next);
      setSyncMainError(failure instanceof Error ? failure.message : "Could not change this setting.");
    }
  }
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
        <ListRow compact title="Project Accounts" leading={<Icon icon={UserMultipleIcon} tone="ink" size={20} />} onPress={() => onOpen("project-accounts")} />
        <View style={styles.separator} />
        <ListRow compact title="Accounts" leading={<Icon icon={UserMultipleIcon} tone="ink" size={20} />} onPress={() => onOpen("accounts")} />
        <View style={styles.separator} />
        <ListRow
          compact
          title="Notifications"
          subtitle={push.state ? (push.state.enabled ? "On" : "Off") : undefined}
          leading={<Icon icon={Notification01Icon} tone="ink" size={20} />}
          onPress={() => onOpen("notifications")}
        />
        <View style={styles.separator} />
        <View style={{ paddingHorizontal: 16 }}>
          <Toggle title="Attention button" selected={attentionButton} onPress={() => setAttentionButton(!attentionButton)} />
        </View>
        <View style={styles.separator} />
        <ListRow compact title="Plan usage" leading={<Icon icon={ChartBarLineIcon} tone="ink" size={20} />} onPress={() => onOpen("usage")} />
        <View style={styles.separator} />
        <ListRow compact title="Skills" leading={<Icon icon={MagicWand01Icon} tone="ink" size={20} />} onPress={() => onOpen("skills")} />
        <View style={styles.separator} />
        <ListRow compact title="MCP" leading={<Icon icon={PlugSocketIcon} tone="ink" size={20} />} onPress={() => onOpen("mcp")} />
        <View style={styles.separator} />
        <ListRow compact title="Appearance" leading={<Icon icon={PaintBoardIcon} tone="ink" size={20} />} onPress={() => onOpen("appearance")} />
        <View style={styles.separator} />
        <ListRow compact title="Experimental" leading={<Icon icon={TestTube01Icon} tone="ink" size={20} />} onPress={() => onOpen("experimental")} />
        <View style={styles.separator} />
        <ListRow compact title="Privacy & AI" leading={<Icon icon={SecurityCheckIcon} tone="ink" size={20} />} onPress={() => onOpen("privacy")} />
        <View style={styles.separator} />
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
      {session.client && syncMain !== null && (
        <>
          <Text style={[styles.label, { marginTop: 16 }]}>Worktrees</Text>
          <View style={[styles.card, { gap: 4 }]}>
            <Toggle title={MAIN_SYNC_TITLE} selected={syncMain} onPress={() => void changeSyncMain(!syncMain)} />
            <Text style={styles.caption}>{MAIN_SYNC_HINT}</Text>
            {syncMainError ? <ErrorNotice message={syncMainError} /> : null}
          </View>
        </>
      )}
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
