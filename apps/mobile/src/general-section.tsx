import { useCallback, useState } from "react";
import { MAIN_SYNC_HINT, MAIN_SYNC_TITLE } from "@milagre/shared/main-sync";
import { Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { ChartBarLineIcon } from "@hugeicons/core-free-icons";
import { Icon } from "./icons";
import { useSession } from "./session";
import { ErrorNotice, ListRow, Toggle, useStyles } from "./ui";

/** Settings › General: plan usage and the connected Mac's worktree default, the phone's share of desktop's General. */
export function GeneralSection() {
  const styles = useStyles();
  const session = useSession();
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
      <Text style={styles.section}>Plan usage</Text>
      <View style={[styles.card, { paddingVertical: 4, gap: 0 }]}>
        <ListRow
          compact
          title="Plan usage"
          subtitle="Claude, Codex and Antigravity plan limits"
          leading={<Icon icon={ChartBarLineIcon} tone="ink" size={20} />}
          onPress={() => router.push("/usage")}
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
    </View>
  );
}
