import { useCallback, useState } from "react";
import { AUTO_UPDATE_HINT, AUTO_UPDATE_TITLE } from "@milagre/shared/auto-update";
import { MAIN_SYNC_HINT, MAIN_SYNC_TITLE } from "@milagre/shared/main-sync";
import { Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { ChartBarLineIcon, ChartColumnIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Row } from "./settings-list";
import { Icon } from "./icons";
import { useSession } from "./session";
import { ErrorNotice, ListRow, Toggle, useStyles } from "./ui";
import { DONE_DEFAULTS, DONE_RETENTION_OPTIONS, retentionLabel } from "@milagre/shared/done";
import { readDoneSettings, saveDoneSettings } from "./done-retention";
import { MacUpdateRows, useMacUpdate } from "./mac-update";

/**
 * Settings › General: plan usage, the connected Mac's worktree default, how long its Done Chats wait before it archives
 * them, and its Milagre update and Auto update (desktop's About).
 */
export function GeneralSection() {
  const styles = useStyles();
  const session = useSession();
  const host = session.client ? session.hosts.find((saved) => saved.id === session.client?.url) : undefined;
  const macName = host?.name || session.hostName || "your Mac";
  // The Mac's desktop app update, checked and installed from here; hidden on a Mac too old to answer.
  const macUpdate = useMacUpdate(session.client);
  // The Mac's Auto update (desktop Settings › About); null until it answers (an older Mac never does).
  const [autoUpdate, setAutoUpdate] = useState<boolean | null>(null);
  const [autoUpdateError, setAutoUpdateError] = useState("");
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      if (!client) return;
      let live = true;
      client.call<{ autoUpdate: boolean } | null>("app-update:auto:read", []).then(
        (value) => live && setAutoUpdate(value ? value.autoUpdate === true : null),
        () => live && setAutoUpdate(null),
      );
      return () => {
        live = false;
      };
    }, [session.client]),
  );
  async function changeAutoUpdate(next: boolean) {
    const client = session.client;
    if (!client || autoUpdate === null) return;
    setAutoUpdateError("");
    setAutoUpdate(next);
    try {
      setAutoUpdate((await client.call<{ autoUpdate: boolean }>("app-update:auto:save", [next])).autoUpdate === true);
    } catch (failure) {
      setAutoUpdate(!next);
      setAutoUpdateError(failure instanceof Error ? failure.message : "Could not change this setting.");
    }
  }
  // The computer's global default for source branch sync; null until it answers (an older Mac never does). Re-read on
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
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.section}>Usage</Text>
      <View style={[styles.card, { paddingVertical: 4, gap: 0 }]}>
        <ListRow
          compact
          title="Plan usage"
          subtitle="Claude, Codex and Antigravity plan limits"
          leading={<Icon icon={ChartBarLineIcon} tone="ink" size={20} />}
          onPress={() => router.push("/usage")}
        />
        <ListRow
          compact
          title="Token usage"
          subtitle="Tokens and estimated cost by Project, Chat and model"
          leading={<Icon icon={ChartColumnIcon} tone="ink" size={20} />}
          onPress={() => router.push("/token-usage")}
        />
      </View>
      {session.client && syncMain !== null && (
        <>
          <Text style={[styles.section, { marginTop: 12 }]}>Worktrees</Text>
          <View style={[styles.card, { gap: 4 }]}>
            <Toggle title={MAIN_SYNC_TITLE} selected={syncMain} onPress={() => void changeSyncMain(!syncMain)} />
            <Text style={styles.caption}>{MAIN_SYNC_HINT}</Text>
            {syncMainError ? <ErrorNotice message={syncMainError} /> : null}
          </View>
        </>
      )}
      <DoneRetention />
      {session.client && (autoUpdate !== null || macUpdate.update !== undefined || macUpdate.restarting) && (
        <>
          <Text style={[styles.section, { marginTop: 12 }]}>Updates</Text>
          <View style={[styles.card, { gap: 4 }]}>
            <MacUpdateRows state={macUpdate} macName={macName} />
            {autoUpdate !== null && (
              <>
                {(macUpdate.update !== undefined || macUpdate.restarting) && <View style={styles.separator} />}
                <Toggle title={AUTO_UPDATE_TITLE} selected={autoUpdate} onPress={() => void changeAutoUpdate(!autoUpdate)} />
                <Text style={styles.caption}>{AUTO_UPDATE_HINT}</Text>
                {autoUpdateError ? <ErrorNotice message={autoUpdateError} /> : null}
              </>
            )}
          </View>
        </>
      )}
    </View>
  );
}

/**
 * How long a Chat waits in the list's Done section before the connected Mac archives it. Kept by that Mac, so it is
 * read on every visit; a Mac too old to have it shows nothing.
 */
function DoneRetention() {
  const styles = useStyles();
  const client = useSession().client;
  const [hours, setHours] = useState<number | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      let live = true;
      void readDoneSettings(client)
        .then((value) => live && setHours(value.retentionHours))
        .catch(() => live && setHours(null));
      return () => {
        live = false;
      };
    }, [client]),
  );
  if (hours === null || !client) return null;
  const choose = (next: number) => {
    const previous = hours;
    setHours(next);
    void saveDoneSettings(client, { retentionHours: next })
      .then((value) => setHours(value.retentionHours))
      .catch(() => setHours(previous ?? DONE_DEFAULTS.retentionHours));
  };
  return (
    <>
      <Text style={[styles.section, { marginTop: 12 }]}>Archive Done chats after</Text>
      {/* One choice of six: a checkmark list, as iOS Settings picks one value. */}
      <View accessibilityRole="radiogroup" style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
        {DONE_RETENTION_OPTIONS.map((option, index) => (
          <View key={option}>
            {index > 0 && <View style={styles.separator} />}
            <Row
              title={retentionLabel(option)}
              chevron={false}
              selected={hours === option}
              trailing={hours === option ? <Icon icon={Tick02Icon} tone="accent" size={20} /> : <View style={{ width: 20 }} />}
              onPress={() => choose(option)}
            />
          </View>
        ))}
      </View>
    </>
  );
}
