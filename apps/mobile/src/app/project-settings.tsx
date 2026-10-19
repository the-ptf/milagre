import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Redirect, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { choiceOf, mainSyncChoices, mainSyncProjectTitle, mainSyncStatusLine, overrideOf } from "@milagre/shared/main-sync";
import type { MainSyncChoice, MainSyncSettings } from "@milagre/shared/main-sync";
import { useSession } from "../session";
import { ProjectIcon, setProjectImage } from "../project-icon";
import { ProjectAccountsGroup } from "../project-accounts-section";
import { ErrorNotice, PageScroll, PillButton, Segmented, Toggle, useStyles } from "../ui";

// Same size as desktop's: the icon is shown small everywhere, and the computer keeps it under 450 KB.
async function pickIcon() {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1] });
  if (result.canceled) return undefined;
  const asset = result.assets[0];
  if (!asset) throw new Error("Could not read this photo.");
  const context = ImageManipulator.manipulate(asset.uri);
  context.resize(asset.width > asset.height ? { width: Math.min(asset.width, 256) } : { height: Math.min(asset.height, 256) });
  const rendered = await context.renderAsync();
  const icon = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true });
  context.release();
  rendered.release();
  if (!icon.base64) throw new Error("Could not read this photo.");
  return `data:image/png;base64,${icon.base64}`;
}

export default function ProjectSettingsScreen() {
  const styles = useStyles();
  const session = useSession();
  const { path, name } = useLocalSearchParams<{ path: string; name?: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const client = session.client;
  // Re-read on every focus: the phone doesn't get main-sync:status, and a sync may have run on the Mac since.
  const [sync, setSync] = useState<MainSyncSettings | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(
    useCallback(() => {
      if (!client || !path) return;
      let live = true;
      setNow(Date.now());
      client.call<MainSyncSettings>("main-sync:read", [path]).then(
        (value) => live && setSync(value),
        () => live && setSync(null),
      );
      return () => {
        live = false;
      };
    }, [client, path]),
  );
  if (!client || !path) return <Redirect href="/" />;
  async function changeSync(choice: MainSyncChoice) {
    setError("");
    try {
      setSync(await client!.call<MainSyncSettings>("main-sync:save", [path, overrideOf(choice)]));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not change this setting.");
    }
  }
  const hidden = !!session.recent.find((project) => project.path === path)?.hidden;
  async function setHidden(next: boolean) {
    setBusy(true);
    setError("");
    try {
      await client!.call("project:set-hidden", [path, next]);
      await session.reloadProjects();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Could not change this setting.";
      setError(/not available from mobile|unknown command/i.test(message) ? "Update Milagre on your Mac to hide Projects from your phone." : message);
    } finally {
      setBusy(false);
    }
  }
  async function save(icon: () => Promise<string | null | undefined>) {
    setBusy(true);
    setError("");
    try {
      const chosen = await icon();
      if (chosen !== undefined) setProjectImage(client!, path, await client!.call<string | null>("project:set-icon", [path, chosen]));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not change the icon.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Stack.Screen options={{ title: name || "Project" }} />
      <PageScroll>
        <Text style={styles.label}>Icon</Text>
        <View style={[styles.card, { alignItems: "center", gap: 16 }]}>
          <ProjectIcon client={client} path={path} size={72} />
          <Text style={[styles.caption, { textAlign: "center" }]}>
            Shown in your Projects list and on the desktop app. Reset goes back to the repository&apos;s own icon.
          </Text>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <PillButton title="Choose photo" loading={busy} onPress={() => void save(pickIcon)} />
            <PillButton title="Reset" secondary disabled={busy} onPress={() => void save(async () => null)} />
          </View>
        </View>
        <Text style={[styles.label, { marginTop: 16 }]}>Projects list</Text>
        <View style={[styles.card, { gap: 4 }]}>
          <Toggle title="Show in Projects list" selected={!hidden} disabled={busy} onPress={() => void setHidden(!hidden)} />
          <Text style={styles.caption}>Hide a Project you only use through a Link. It also leaves the sidebar on your Mac when that shows every Project.</Text>
        </View>
        {sync && (
          <>
            <Text style={[styles.label, { marginTop: 16 }]}>Main branch</Text>
            <View style={[styles.card, { gap: 8 }]}>
              <Text style={styles.caption}>{mainSyncProjectTitle(sync.branch)}</Text>
              <Segmented
                label={mainSyncProjectTitle(sync.branch)}
                value={choiceOf(sync.override)}
                options={mainSyncChoices(sync.defaultValue)}
                onChange={(value) => void changeSync(value as MainSyncChoice)}
              />
              <Text style={styles.caption}>{mainSyncStatusLine(sync.last, now)}</Text>
            </View>
          </>
        )}
        {error ? <ErrorNotice message={error} /> : null}
        <View style={{ marginTop: 16 }}>
          <ProjectAccountsGroup path={path} />
        </View>
      </PageScroll>
    </>
  );
}
