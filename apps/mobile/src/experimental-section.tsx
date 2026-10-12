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
import { DEFAULT_THEME_ID, seedsFrom } from "@milagre/shared/themes";
import { CustomThemeSection } from "./custom-theme-section";
import { useMuriloMode } from "./murilo-mode";
import { useFloatingInbox, useFloatingInboxActivity } from "./floating-inbox-setting";
import { useUltracodeFatality } from "./ultracode-fatality-setting";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { ErrorNotice, Toggle, useStyles } from "./ui";

/** Settings › Experimental: this phone's and the connected Mac's experimental switches, like desktop's Experimental section. */
export function ExperimentalSection() {
  const styles = useStyles();
  const session = useSession();
  const [muriloMode, setMuriloMode] = useMuriloMode();
  const [floatingInbox, setFloatingInbox] = useFloatingInbox();
  const [inboxActivity, setInboxActivity] = useFloatingInboxActivity();
  const [fatality, setFatality] = useUltracodeFatality();
  const { settings, set } = useTheme();
  // On: start from the current theme's colors and select Custom. Off while Custom is selected: back to Milagre Blue, seeds kept.
  function changeCustomTheme(enabled: boolean) {
    if (!enabled) {
      set({ customThemeEnabled: false, ...(settings.colorTheme === "custom" ? { colorTheme: DEFAULT_THEME_ID } : {}) });
      return;
    }
    const from = settings.colorTheme === "custom" ? DEFAULT_THEME_ID : settings.colorTheme;
    set({ customThemeEnabled: true, customTheme: settings.customTheme ?? seedsFrom(from), colorTheme: "custom" });
  }
  // The Mac's Linear switch and connection; null until the Mac answers (an older Mac never does). Re-read on focus:
  // the phone gets no event when the Mac connects or disconnects.
  // `moveToStarted` is on when a Mac that predates the switch sends none.
  const [linear, setLinear] = useState<{ enabled: boolean; moveToStarted: boolean; status: LinearStatus } | null>(null);
  const [linearError, setLinearError] = useState("");
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      if (!client) return;
      let live = true;
      Promise.all([client.call<{ enabled: boolean; moveToStarted?: boolean }>("linear:enabled:read", []), client.call<LinearStatus>("linear:status", [])]).then(
        // An older Mac answers null for commands it lacks: no Linear card.
        ([value, status]) =>
          live && setLinear(value && status ? { enabled: value.enabled === true, moveToStarted: value.moveToStarted !== false, status } : null),
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
  return (
    <View style={{ gap: 8 }}>
      {/* This phone's own switches, kept on the phone. */}
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle title="Floating inbox" selected={floatingInbox} onPress={() => setFloatingInbox(!floatingInbox)} />
        <Text style={styles.caption}>
          A movable inbox button in the Chat. Tap to answer questions or approve requests. Flick it toward the left or right edge to tuck it away.
        </Text>
        {floatingInbox && (
          <View style={{ marginLeft: 16, gap: 4 }}>
            <Toggle title="Show chat activity" selected={inboxActivity} onPress={() => setInboxActivity(!inboxActivity)} />
            <Text style={styles.caption}>Include working chats with a progress summary and finished updates. Off: only questions and permission requests.</Text>
          </View>
        )}
      </View>
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle title="Murilo mode" selected={muriloMode} onPress={() => setMuriloMode(!muriloMode)} />
        <Text style={styles.caption}>
          Shows every tool call in the Chat, one row each, with the agent&apos;s notes between them. Replies no longer fold their activity into one line.
        </Text>
      </View>
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle title="Ultracode Fatality" selected={fatality} onPress={() => setFatality(!fatality)} />
        <Text style={styles.caption}>
          Turning Ultracode on darkens the screen, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud.
        </Text>
      </View>
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle title="Custom theme" selected={settings.customThemeEnabled} onPress={() => changeCustomTheme(!settings.customThemeEnabled)} />
        <Text style={styles.caption}>Build a theme from a few colors. It shows up as &quot;Custom&quot; in Appearance.</Text>
      </View>
      {settings.customThemeEnabled && <CustomThemeSection />}
      {!session.client && <Text style={styles.caption}>Connect to a Mac to change its experimental features.</Text>}
      {session.client && linear !== null && (
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
      )}
    </View>
  );
}
