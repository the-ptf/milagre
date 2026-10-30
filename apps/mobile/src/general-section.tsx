import { useCallback, useState } from "react";
import { AUTO_UPDATE_HINT, AUTO_UPDATE_TITLE } from "@milagre/shared/auto-update";
import { MAIN_SYNC_HINT, MAIN_SYNC_TITLE } from "@milagre/shared/main-sync";
import { View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { ChartBarLineIcon } from "@hugeicons/core-free-icons";
import { space } from "./design-tokens";
import { Icon } from "./icons";
import { useSession } from "./session";
import { Group, InlineError, ListRow, Toggle } from "./ui";

/** Settings › General: plan usage, the connected Mac's worktree default and its Auto update (desktop's About). */
export function GeneralSection() {
  const session = useSession();
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
    <View style={{ gap: space.section }}>
      <Group title="Plan usage">
        <ListRow
          compact
          title="Plan usage"
          subtitle="Claude, Codex and Antigravity plan limits"
          leading={<Icon icon={ChartBarLineIcon} tone="ink" size={20} />}
          onPress={() => router.push("/usage")}
        />
      </Group>
      {session.client && syncMain !== null && (
        <View style={{ gap: space.md }}>
          <Group title="Worktrees" footer={MAIN_SYNC_HINT}>
            <Toggle title={MAIN_SYNC_TITLE} selected={syncMain} onPress={() => void changeSyncMain(!syncMain)} />
          </Group>
          <InlineError message={syncMainError} style={{ paddingHorizontal: 16 }} />
        </View>
      )}
      {session.client && autoUpdate !== null && (
        <View style={{ gap: space.md }}>
          <Group title="Updates" footer={AUTO_UPDATE_HINT}>
            <Toggle title={AUTO_UPDATE_TITLE} selected={autoUpdate} onPress={() => void changeAutoUpdate(!autoUpdate)} />
          </Group>
          <InlineError message={autoUpdateError} style={{ paddingHorizontal: 16 }} />
        </View>
      )}
    </View>
  );
}
