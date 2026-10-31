import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { permissionMissing } from "@milagre/shared/computer-use";
import type { ComputerUsePermission, ComputerUseSettings, ComputerUseStatus } from "@milagre/shared/computer-use";
import { useSession } from "./session";
import { Group, Row } from "./settings-list";
import { useTheme } from "./theme";
import { ErrorNotice, Toggle, useStyles } from "./ui";

const message = (error: unknown) => (error instanceof Error ? error.message : "Could not reach this Mac.");

/**
 * Settings › Experimental › Computer use, as on desktop: agents operate apps on the connected Mac. Grant opens System
 * Settings there, where the user (or someone at the Mac) turns the permission on.
 */
export function ComputerUseSection() {
  const styles = useStyles();
  const { colors } = useTheme();
  const client = useSession().client;
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [guided, setGuided] = useState(false);
  const refresh = useCallback(() => {
    if (!client) return () => {};
    let live = true;
    setLoadError("");
    client.call<ComputerUseStatus>("computer-use:status", []).then(
      (value) => live && setStatus(value),
      (cause) => live && setLoadError(message(cause)),
    );
    return () => {
      live = false;
    };
  }, [client]);
  useFocusEffect(refresh);
  const save = async (patch: Partial<ComputerUseSettings>) => {
    if (!client) return;
    setSaving(true);
    setError("");
    try {
      await client.call<ComputerUseSettings>("computer-use:settings:save", [patch]);
      refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  };
  const grant = () => {
    if (!client) return;
    setError("");
    client.call("computer-use:guide", []).then(
      () => setGuided(true),
      (cause) => setError(message(cause)),
    );
  };
  if (!client) return <Text style={styles.muted}>Connect to a Mac to set up computer use.</Text>;
  if (loadError) return <ErrorNotice message={`This Mac can't run computer use yet. Update Milagre on it. (${loadError})`} />;
  if (!status) return <Text style={styles.muted}>Loading...</Text>;
  const permission = (title: string, state: ComputerUsePermission) => (
    <Row
      key={title}
      title={title}
      value={permissionMissing(state) ? "Grant" : "Granted"}
      chevron={false}
      disabled={!permissionMissing(state)}
      onPress={permissionMissing(state) ? grant : undefined}
    />
  );
  return (
    <View style={{ gap: 20 }}>
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle
          title="Computer use"
          selected={status.enabled}
          disabled={saving || !status.supported}
          tint={colors.accent}
          onPress={() => void save({ enabled: !status.enabled })}
        />
        <Text style={styles.caption}>
          {status.supported
            ? "Agents can see and operate apps on the Mac. They ask before each new app, and never move the pointer or take focus."
            : "Not available on this Mac."}
        </Text>
      </View>
      {status.enabled && status.supported && (
        <View style={[styles.card, { gap: 4 }]}>
          <Toggle
            title="Show the agent's cursor"
            selected={status.cursor}
            disabled={saving}
            tint={colors.accent}
            onPress={() => void save({ cursor: !status.cursor })}
          />
          <Text style={styles.caption}>
            Draw Milagre&apos;s cursor and the current step on the Mac&apos;s screen while an agent acts. The pointer never moves. Not drawing yet on macOS 27
            with agent-desktop 1.0.2.
          </Text>
        </View>
      )}
      {status.enabled && status.supported && status.permissions && (
        <Group
          title="Permissions on the Mac"
          footer={guided ? "System Settings is open on the Mac. Turn Milagre on there, then come back." : "Grant opens System Settings on the Mac."}
        >
          {permission("Accessibility", status.permissions.accessibility)}
          {permission("Screen Recording", status.permissions.screenRecording)}
        </Group>
      )}
      {status.enabled && status.supported && (
        <Group title="Never used by agents" footer={`Uses agent-desktop ${status.version} by Vercel Labs. Apps you allow stay allowed only in that Chat.`}>
          {[
            <Text key="apps" style={[styles.caption, { paddingVertical: 12 }]}>
              {status.blockedApps.join(", ")}
            </Text>,
          ]}
        </Group>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={[styles.caption, { color: colors.redInk }]}>
          {error}
        </Text>
      )}
    </View>
  );
}
