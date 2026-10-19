import { useCallback, useState } from "react";
import {
  LINEAR_HINT,
  LINEAR_MOVE_TO_STARTED_HINT,
  LINEAR_MOVE_TO_STARTED_TITLE,
  LINEAR_TITLE,
  linearReadOnlyHint,
  linearStatusLine,
  linearWorkspaceLine,
  linearWorkspaces,
  type LinearStatus,
} from "@milagre/shared/linear";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSession } from "./session";
import { ErrorNotice, Toggle, useStyles } from "./ui";

/** Settings › Connections › Linear: the connected Mac's Linear switch and workspaces, like desktop's Connections section. Only the Mac connects. */
export function LinearSection() {
  const styles = useStyles();
  const session = useSession();
  // The Mac's Linear switch and connection; null until the Mac answers (an older Mac never does). Re-read on focus:
  // the phone gets no event when the Mac connects or disconnects.
  // `moveToStarted` is on when a Mac that predates the switch sends none.
  const [linear, setLinear] = useState<{
    enabled: boolean;
    moveToStarted: boolean;
    status: LinearStatus;
  } | null>(null);
  const [linearError, setLinearError] = useState("");
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      if (!client) return;
      let live = true;
      Promise.all([client.call<{ enabled: boolean; moveToStarted?: boolean }>("linear:enabled:read", []), client.call<LinearStatus>("linear:status", [])]).then(
        // An older Mac answers null for commands it lacks: no Linear card.
        ([value, status]) =>
          live &&
          setLinear(
            value && status
              ? {
                  enabled: value.enabled === true,
                  moveToStarted: value.moveToStarted !== false,
                  status,
                }
              : null,
          ),
        () => live && setLinear(null),
      );
      return () => {
        live = false;
      };
    }, [session.client]),
  );
  async function changeLinear(next: boolean) {
    const client = session.client;
    if (!client || !linear) return;
    setLinearError("");
    setLinear({ ...linear, enabled: next });
    try {
      const { enabled } = await client.call<{ enabled: boolean }>("linear:enabled:save", [next]);
      setLinear((current) => current && { ...current, enabled });
    } catch (failure) {
      setLinear((current) => current && { ...current, enabled: !next });
      setLinearError(failure instanceof Error ? failure.message : "Could not change this setting.");
    }
  }
  async function changeMoveToStarted(next: boolean) {
    const client = session.client;
    if (!client || !linear) return;
    setLinearError("");
    setLinear({ ...linear, moveToStarted: next });
    try {
      const { moveToStarted } = await client.call<{ moveToStarted: boolean }>("linear:move-to-started:save", [next]);
      setLinear((current) => current && { ...current, moveToStarted });
    } catch (failure) {
      setLinear((current) => current && { ...current, moveToStarted: !next });
      setLinearError(failure instanceof Error ? failure.message : "Could not change this setting.");
    }
  }
  if (!session.client) return <Text style={styles.caption}>Connect to a Mac to change its Linear connection.</Text>;
  if (linear === null) return <Text style={styles.caption}>This Mac has no Linear connection to show.</Text>;
  return (
    <View style={{ gap: 8 }}>
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle title={LINEAR_TITLE} selected={linear.enabled} onPress={() => void changeLinear(!linear.enabled)} />
        <Text style={styles.caption}>{LINEAR_HINT}</Text>
        {linear.enabled &&
          (linearWorkspaces(linear.status).length ? (
            linearWorkspaces(linear.status).map((workspace) => (
              <Text key={workspace.id} style={styles.caption}>
                {`Connected to ${linearWorkspaceLine(workspace)}` +
                  (linear.moveToStarted && workspace.canWrite === false ? `. ${linearReadOnlyHint("phone")}` : "")}
              </Text>
            ))
          ) : (
            <Text style={styles.caption}>{linearStatusLine(linear.status, "phone")}</Text>
          ))}
        {linear.enabled && linear.status.connected && (
          <>
            <Toggle title={LINEAR_MOVE_TO_STARTED_TITLE} selected={linear.moveToStarted} onPress={() => void changeMoveToStarted(!linear.moveToStarted)} />
            <Text style={styles.caption}>{LINEAR_MOVE_TO_STARTED_HINT}</Text>
          </>
        )}
        {linearError ? <ErrorNotice message={linearError} /> : null}
      </View>
    </View>
  );
}
