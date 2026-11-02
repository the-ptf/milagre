import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { installQuestion, noDesktopUpdate, updateAvailable, updateBusy, updateDescription, type HostUpdate } from "@milagre/shared/app-update";
import type { Client } from "./client";
import { confirm } from "./confirm-store";
import { radius } from "./design-tokens";
import { Button, ErrorNotice, useStyles } from "./ui";
import { useTheme } from "./theme";

// How often the screen reads the update again while it moves: checking, downloading, restarting.
const FOLLOW_MS = 2000;
// The Mac answered and refused (no update ready, a demo Mac): the install never started. Anything else (the Mac going
// away mid-restart, a proxy's 502) may be the restart itself.
const refused = (failure: unknown) => {
  const status = (failure as { status?: number })?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
};
const message = (failure: unknown) => (failure instanceof Error ? failure.message : "Could not reach your Mac.");

/**
 * The connected Mac's Milagre desktop app update (Settings › General › Updates), read through its host
 * (app-update:state, check, install). `update` is undefined until the Mac answers, and stays so on a Mac too old to have
 * these commands; null while no desktop app is open there.
 */
export function useMacUpdate(client: Client | null) {
  const [update, setUpdate] = useState<HostUpdate | undefined>(undefined);
  const [error, setError] = useState("");
  // Installing restarts Milagre on the Mac, which drops this phone's connection for a moment; until it answers again
  // with the update done (or refused), the row says it is restarting.
  const [restarting, setRestarting] = useState(false);
  const following = restarting || updateBusy(update ?? null);
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      let live = true;
      const show = (value: HostUpdate) => {
        if (!live) return;
        setUpdate(value);
        if (value?.status !== "installing") setRestarting(false);
      };
      // While the Mac restarts it can't answer; otherwise it has no such command, or no answer to give.
      const lost = () => {
        if (live && !restarting) setUpdate(undefined);
      };
      const read = () => client.call<HostUpdate>("app-update:state", []).then(show, lost);
      void read();
      const timer = following ? setInterval(() => void read(), FOLLOW_MS) : null;
      return () => {
        live = false;
        if (timer) clearInterval(timer);
      };
    }, [client, following, restarting]),
  );
  const check = async () => {
    if (!client) return;
    setError("");
    try {
      setUpdate(await client.call<HostUpdate>("app-update:check", []));
    } catch (failure) {
      setError(message(failure));
    }
  };
  const install = async (macName: string) => {
    if (!client || !update) return;
    const question = installQuestion(macName, update.version);
    if (!(await confirm(question.title, question.message, question.action))) return;
    setError("");
    setRestarting(true);
    try {
      setUpdate(await client.call<HostUpdate>("app-update:install", []));
    } catch (failure) {
      if (!refused(failure)) return;
      setRestarting(false);
      setError(message(failure));
    }
  };
  return { update, error, restarting, following, check, install };
}

/** The rows of that update, above the Auto update switch in the Updates card. */
export function MacUpdateRows({ state, macName }: { state: ReturnType<typeof useMacUpdate>; macName: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { update, error, restarting, following } = state;
  if (update === undefined && !restarting) return null;
  if (update === null && !restarting)
    return (
      <View style={{ paddingBottom: 8 }}>
        <Text style={styles.muted}>{noDesktopUpdate(macName)}</Text>
      </View>
    );
  const available = update ? updateAvailable(update) : null;
  const description = restarting && update?.status !== "installing" ? `Restarting Milagre on ${macName}.` : updateDescription(update ?? null);
  return (
    <View style={{ gap: 10, paddingBottom: 8 }}>
      {update && (
        <View accessible style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 28 }}>
          <Text style={styles.text}>Milagre on {macName}</Text>
          <Text style={[styles.muted, { fontVariant: ["tabular-nums"] }]}>{update.current}</Text>
        </View>
      )}
      {available && <Text style={[styles.text, { fontWeight: "600" }]}>{available}</Text>}
      <Text style={styles.caption}>{description}</Text>
      {update?.status === "downloading" && (
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(update.progress) }}
          style={{ height: 5, borderRadius: radius.full, backgroundColor: colors.lineStrong, overflow: "hidden" }}
        >
          <View style={{ width: `${Math.max(2, Math.min(100, update.progress))}%`, height: "100%", borderRadius: radius.full, backgroundColor: colors.ink }} />
        </View>
      )}
      {error ? <ErrorNotice message={error} /> : null}
      {update?.status === "downloaded" && !restarting ? <Button title="Install & restart" onPress={() => void state.install(macName)} /> : null}
      {update?.status !== "unavailable" && (
        <Button
          title={restarting || update?.status === "installing" ? "Restarting…" : "Check for updates"}
          secondary
          loading={restarting || update?.status === "checking"}
          disabled={following}
          onPress={() => void state.check()}
        />
      )}
    </View>
  );
}
