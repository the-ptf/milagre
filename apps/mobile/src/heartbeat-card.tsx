import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { triggerText } from "@milagre/shared/routines";
import type { ChatStep } from "@milagre/shared/model";
import { useSession } from "./session";
import { useRoutines } from "./use-routines";
import { heartbeatEnd } from "./routine-rows";
import { Icon } from "./icons";
import { InlineError, PillButton } from "./ui";
import { lineHeight, radius, type } from "./design-tokens";
import { useTheme } from "./theme";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function HeartbeatCard({ step }: { step: ChatStep }) {
  const { colors } = useTheme();
  const { client } = useSession();
  const routines = useRoutines(client);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [now] = useState(Date.now);
  const ref = step.routine;
  if (!ref) return null;
  const found = routines.routines.find((item) => item.id === ref.id);
  const ended = !!found?.completedAt;
  const routine = ended ? undefined : found;
  const known = !routines.loading && !routines.unavailable && !routines.error;
  const end = routine ? heartbeatEnd(routine, now) : "";
  const meta = routine ? [capital(triggerText(routine.trigger)), end].filter(Boolean).join(" · ") : ended ? "Ended" : known ? "Stopped" : "";
  async function stop() {
    if (!client || !ref || stopping) return;
    setStopping(true);
    setError("");
    try {
      await client.call("routines:delete", [ref.id]);
      await routines.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not stop this Heartbeat.");
    } finally {
      setStopping(false);
    }
  }
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 12,
        borderRadius: radius.card,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
      }}
    >
      <Icon icon={Pulse01Icon} tone={routine ? "ink" : "ink3"} size={20} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={2} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" }}>
          {`Heartbeat set: ${ref.name}`}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
            {meta}
          </Text>
        ) : null}
        <InlineError message={error} />
      </View>
      {routine ? (
        <PillButton size="small" secondary title="Stop" accessibilityLabel={`Stop ${ref.name}`} loading={stopping} onPress={() => void stop()} />
      ) : null}
    </View>
  );
}
