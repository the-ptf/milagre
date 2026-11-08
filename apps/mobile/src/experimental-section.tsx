import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { space } from "./design-tokens";
import { useFocusEffect } from "expo-router";
import { useFloatingInbox, useFloatingInboxActivity } from "./floating-inbox-setting";
import { useSession } from "./session";
import type { Client } from "./client";
import { useUltracodeFatality } from "./ultracode-fatality-setting";
import { Toggle, useStyles } from "./ui";
import { useTheme } from "./theme";
import { DEVICE_NOTES_DESCRIPTION, DEVICE_NOTES_LABEL, DEVICE_NOTES_WARNING } from "@milagre/shared/device-notes";

/** Settings › Church: features still taking shape, like desktop's Church section. Babysit PRs, Simlock and Computer use graduated. */
export function ExperimentalSection() {
  const styles = useStyles();
  const { colors } = useTheme();
  const [floatingInbox, setFloatingInbox] = useFloatingInbox();
  const [inboxActivity, setInboxActivity] = useFloatingInboxActivity();
  const [fatality, setFatality] = useUltracodeFatality();
  const session = useSession();
  // Device notes, also kept by the Mac (its agents get the notes); null on a Mac without them.
  const [deviceNotes, setDeviceNotes] = useState<boolean | null>(null);
  const [deviceNotesError, setDeviceNotesError] = useState("");
  const [deviceNotesSaving, setDeviceNotesSaving] = useState(false);
  const [deviceNotesClient, setDeviceNotesClient] = useState(session.client);
  if (deviceNotesClient !== session.client) {
    setDeviceNotesClient(session.client);
    setDeviceNotes(null);
    setDeviceNotesError("");
    setDeviceNotesSaving(false);
  }
  // Keep a pending write across blur/focus, but never apply its reply to a different connection.
  const deviceNotesScope = useRef<{ client: Client; saving: boolean; revision: number } | null>(null);
  useEffect(() => {
    const client = session.client;
    deviceNotesScope.current = client ? { client, saving: false, revision: 0 } : null;
    return () => {
      deviceNotesScope.current = null;
    };
  }, [session.client]);
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      if (!client) return;
      let live = true;
      const scope = deviceNotesScope.current;
      if (scope && scope.client === client && !scope.saving) {
        const revision = ++scope.revision;
        const current = () => live && deviceNotesScope.current === scope && scope.revision === revision;
        client.call<{ enabled: boolean } | null>("device-notes:read", []).then(
          (value) => current() && setDeviceNotes(value ? value.enabled === true : null),
          () => current() && setDeviceNotes(null),
        );
      }
      return () => {
        live = false;
      };
    }, [session.client]),
  );
  return (
    <View style={{ gap: space.md }}>
      <View style={[styles.card, { gap: space.xs }]}>
        <Toggle title="Floating inbox" selected={floatingInbox} onPress={() => setFloatingInbox(!floatingInbox)} />
        <Text style={styles.caption}>
          A movable inbox button in the Chat. Tap to answer questions or approve requests. Flick it toward the left or right edge to tuck it away.
        </Text>
        {floatingInbox && (
          <View style={{ marginLeft: 16, gap: 4 }}>
            <Toggle title="Show Chat activity" selected={inboxActivity} onPress={() => setInboxActivity(!inboxActivity)} />
            <Text style={styles.caption}>Include working Chats with a progress summary and finished updates. Off: only questions and permission requests.</Text>
          </View>
        )}
      </View>
      <View style={[styles.card, { gap: space.xs }]}>
        <Toggle title="Ultracode Fatality" selected={fatality} onPress={() => setFatality(!fatality)} />
        <Text style={styles.caption}>
          Turning Ultracode on darkens the screen, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud.
        </Text>
      </View>
      {session.client && deviceNotesClient === session.client && deviceNotes !== null && (
        <View style={[styles.card, { gap: 4 }]}>
          <Toggle
            title={DEVICE_NOTES_LABEL}
            selected={deviceNotes}
            disabled={deviceNotesSaving}
            onPress={() => {
              const scope = deviceNotesScope.current;
              if (!scope || scope.client !== session.client || scope.saving) return;
              scope.saving = true;
              ++scope.revision; // A read started before this write must not replace its acknowledgement.
              const next = !deviceNotes;
              setDeviceNotesSaving(true);
              setDeviceNotesError("");
              scope.client.call<{ enabled: boolean }>("device-notes:save", [next]).then(
                (value) => {
                  if (deviceNotesScope.current !== scope) return;
                  scope.saving = false;
                  setDeviceNotesSaving(false);
                  setDeviceNotes(value.enabled === true);
                },
                (error: Error) => {
                  if (deviceNotesScope.current !== scope) return;
                  scope.saving = false;
                  setDeviceNotesSaving(false);
                  setDeviceNotesError(error.message || "Could not change this setting.");
                },
              );
            }}
          />
          <Text style={styles.caption}>{DEVICE_NOTES_DESCRIPTION}</Text>
          <Text style={[styles.caption, { color: colors.orangeInk }]}>{DEVICE_NOTES_WARNING}</Text>
          {!!deviceNotesError && <Text style={[styles.caption, { color: colors.redInk }]}>{deviceNotesError}</Text>}
        </View>
      )}
    </View>
  );
}
