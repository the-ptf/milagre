import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useFloatingInbox, useFloatingInboxActivity } from "./floating-inbox-setting";
import { useUltracodeFatality } from "./ultracode-fatality-setting";
import { useSession } from "./session";
import { ErrorNotice, ListRow, PillButton, Toggle, useStyles } from "./ui";

/** Settings › Experimental: this phone's and the connected Mac's experimental features, like desktop's Experimental section. */
export function ExperimentalSection() {
  const styles = useStyles();
  const session = useSession();
  const [floatingInbox, setFloatingInbox] = useFloatingInbox();
  const [inboxActivity, setInboxActivity] = useFloatingInboxActivity();
  const [fatality, setFatality] = useUltracodeFatality();
  const [sharingOwner, setSharingOwner] = useState<typeof session.client>(null);
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      setSharingOwner(null);
      if (!client) return;
      let live = true;
      // Owner history remains available without a live Chat or a reachable sharing service.
      // Confined demo phones and older hosts reject this call or return no history.
      client.call<unknown>("artifact:all-page-shares", []).then(
        (history) => live && setSharingOwner(Array.isArray(history) ? client : null),
        () => live && setSharingOwner(null),
      );
      return () => {
        live = false;
      };
    }, [session.client]),
  );
  // The Mac's Routines switch; null until the Mac answers (an older Mac rejects the read).
  const [routines, setRoutines] = useState<boolean | null>(null);
  const [routinesError, setRoutinesError] = useState("");
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      if (!client) return;
      let live = true;
      client.call<{ enabled: boolean } | null>("routines:enabled:read", []).then(
        (value) => live && setRoutines(value ? value.enabled === true : null),
        () => live && setRoutines(null),
      );
      return () => {
        live = false;
      };
    }, [session.client]),
  );
  async function changeRoutines(next: boolean) {
    const client = session.client;
    if (!client || routines === null) return;
    setRoutinesError("");
    setRoutines(next);
    try {
      const value = await client.call<{ enabled: boolean }>("routines:enabled:save", [next]);
      setRoutines(value.enabled === true);
    } catch (failure) {
      setRoutines(!next);
      setRoutinesError(failure instanceof Error ? failure.message : "Could not change this setting.");
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
        <Toggle title="Ultracode Fatality" selected={fatality} onPress={() => setFatality(!fatality)} />
        <Text style={styles.caption}>
          Turning Ultracode on darkens the screen, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud.
        </Text>
      </View>
      {!session.client && <Text style={styles.caption}>Connect to a Mac to change its experimental features.</Text>}
      {session.client && (
        <View style={[styles.card, { gap: 4 }]}>
          <Toggle
            title="Designs"
            selected={session.designs.enabled === true}
            disabled={session.designs.enabled === null || session.designs.stale || session.designs.saving}
            onPress={() => void session.designs.save(session.designs.enabled !== true)}
          />
          <Text style={styles.caption}>Create editable designs in Chat.</Text>
          {sharingOwner === session.client && (
            <ListRow
              compact
              title="Published pages"
              subtitle="Manage public snapshots, including pages from deleted Chats."
              onPress={() => router.push("/published-pages")}
            />
          )}
          {session.designs.saving ? (
            <Text style={styles.caption}>Saving...</Text>
          ) : session.designs.stale && !session.designs.error ? (
            <Text style={styles.caption}>Checking your Mac...</Text>
          ) : null}
          {session.designs.stale && session.designs.enabled !== null && <Text style={styles.caption}>Showing the last confirmed setting.</Text>}
          {session.designs.error ? (
            <>
              <ErrorNotice message={session.designs.error} />
              <PillButton title="Retry Designs setting" secondary onPress={() => void session.designs.refresh()} />
            </>
          ) : null}
        </View>
      )}
      {session.client && routines !== null && (
        <View style={[styles.card, { gap: 4 }]}>
          <Toggle title="Routines" selected={routines} onPress={() => void changeRoutines(!routines)} />
          <Text style={styles.caption}>Let agents set Heartbeats that check back on a Chat on a schedule. Open Chats get it after Reload chat.</Text>
          {routinesError ? <ErrorNotice message={routinesError} /> : null}
        </View>
      )}
    </View>
  );
}
