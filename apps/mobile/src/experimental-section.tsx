import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useFloatingInbox, useFloatingInboxActivity } from "./floating-inbox-setting";
import { useSession } from "./session";
import type { Client } from "./client";
import { Row } from "./settings-list";
import { useUltracodeFatality } from "./ultracode-fatality-setting";
import { Toggle, useStyles } from "./ui";
import { useTheme } from "./theme";
import { DEVICE_NOTES_DESCRIPTION, DEVICE_NOTES_LABEL, DEVICE_NOTES_WARNING } from "@milagre/shared/device-notes";

/** Settings › Experimental: this phone's experimental features, like desktop's Experimental section. */
export function ExperimentalSection() {
  const styles = useStyles();
  const { colors } = useTheme();
  const [floatingInbox, setFloatingInbox] = useFloatingInbox();
  const [inboxActivity, setInboxActivity] = useFloatingInboxActivity();
  const [fatality, setFatality] = useUltracodeFatality();
  const session = useSession();
  // Babysit PRs lives on the connected Mac; null until it answers, and an older Mac never has it. Re-read on focus: its
  // page or the Mac may have changed it.
  const [babysit, setBabysit] = useState<boolean | null>(null);
  // Simlock devices, also kept by the Mac; null on a Mac without them.
  const [simlock, setSimlock] = useState<boolean | null>(null);
  // Computer use, also kept by the Mac; null on a Mac without it.
  const [computerUse, setComputerUse] = useState<boolean | null>(null);
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
      client.call<{ enabled: boolean } | null>("babysit:settings:read", []).then(
        (value) => live && setBabysit(value ? value.enabled === true : null),
        () => live && setBabysit(null),
      );
      client.call<{ enabled: boolean } | null>("simlock:settings:read", []).then(
        (value) => live && setSimlock(value ? value.enabled === true : null),
        () => live && setSimlock(null),
      );
      client.call<{ enabled: boolean } | null>("computer-use:settings:read", []).then(
        (value) => live && setComputerUse(value ? value.enabled === true : null),
        () => live && setComputerUse(null),
      );
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
    <View style={{ gap: 8 }}>
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
      {session.client && babysit !== null && (
        <View style={[styles.card, { gap: 4, paddingVertical: 4 }]}>
          <Row title="Babysit PRs" value={babysit ? "On" : "Off"} onPress={() => router.push("/babysit-prs")} />
          <Text style={[styles.caption, { paddingBottom: 12 }]}>Watch every PR a Chat opens and fix review comments, failed checks and conflicts.</Text>
        </View>
      )}
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
      {session.client && simlock !== null && (
        <View style={[styles.card, { gap: 4, paddingVertical: 4 }]}>
          <Row title="Simlock devices" value={simlock ? "On" : "Off"} onPress={() => router.push("/simlock")} />
          <Text style={[styles.caption, { paddingBottom: 12 }]}>
            Agents lease a simulator or emulator of their own from a Simlock pool and return it wiped.
          </Text>
        </View>
      )}
      {session.client && computerUse !== null && (
        <View style={[styles.card, { gap: 4, paddingVertical: 4 }]}>
          <Row title="Computer use" value={computerUse ? "On" : "Off"} onPress={() => router.push("/computer-use")} />
          <Text style={[styles.caption, { paddingBottom: 12 }]}>Agents see and operate apps on the Mac, asking before each new app.</Text>
        </View>
      )}
    </View>
  );
}
