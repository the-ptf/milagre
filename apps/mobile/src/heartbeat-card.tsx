import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { triggerText } from "@milagre/shared/routines";
import type { ChatStep } from "@milagre/shared/model";
import { useSession } from "./session";
import { useRoutines } from "./use-routines";
import { heartbeatEnd } from "./routine-rows";
import { Icon } from "./icons";
import { tap } from "./ui";
import { useTheme } from "./theme";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The Heartbeat an agent set in this reply (its heartbeat_create step): its name, how often and until when, and Stop,
 * which deletes it. Once the Heartbeat is gone (stopped, ended or deleted) the card says Stopped.
 */
export function HeartbeatCard({ step }: { step: ChatStep }) {
  const { colors } = useTheme();
  const { client } = useSession();
  const routines = useRoutines(client);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  // Only "ends 18:00" (today) against "ends Oct 24" reads the time, so the time the card first showed is enough.
  const [now] = useState(Date.now);
  const ref = step.routine;
  if (!ref) return null;
  const routine = routines.routines.find((item) => item.id === ref.id);
  // Until the list is read the card can't tell a live Heartbeat from a stopped one, so it says neither.
  const known = !routines.loading && !routines.unavailable && !routines.error;
  const end = routine ? heartbeatEnd(routine, now) : "";
  const meta = routine ? [capital(triggerText(routine.trigger)), end].filter(Boolean).join(" · ") : known ? "Stopped" : "";
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
        borderRadius: 14,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
      }}
    >
      <Icon icon={Pulse01Icon} tone={routine ? "ink" : "ink3"} size={20} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={2} style={{ color: colors.ink, fontSize: 15, fontWeight: "500" }}>
          {`Heartbeat set: ${ref.name}`}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 12 }}>
            {meta}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: colors.error, fontSize: 12 }}>
            {error}
          </Text>
        ) : null}
      </View>
      {routine ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Stop ${ref.name}`}
          accessibilityState={{ disabled: stopping, busy: stopping }}
          disabled={stopping}
          hitSlop={6}
          onPress={() => {
            tap();
            void stop();
          }}
          style={({ pressed }) => ({
            height: 30,
            paddingHorizontal: 12,
            borderRadius: 15,
            borderCurve: "continuous",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: colors.lineStrong,
            backgroundColor: colors.surface,
            opacity: stopping ? 0.4 : pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: colors.ink, fontSize: 13, fontWeight: "500" }}>Stop</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
