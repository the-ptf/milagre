import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSession } from "./session";
import { ErrorNotice, Toggle, useStyles } from "./ui";

/** Settings › Accounts › Usage limits: the connected Mac's auto-switch, like desktop. Nothing shows for an older Mac. */
export function LimitAutoSwitchSection() {
  const styles = useStyles();
  const session = useSession();
  // The Mac's limit auto-switch; null until the Mac answers (an older Mac never does).
  const [autoSwitch, setAutoSwitch] = useState<boolean | null>(null);
  const [autoSwitchError, setAutoSwitchError] = useState("");
  const [resumeAtReset, setResumeAtReset] = useState<boolean | null>(null);
  const [resumeError, setResumeError] = useState("");
  const [savingResume, setSavingResume] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      if (session.client)
        void session.client.call<{ resumeAtReset: boolean }>("limits:resume-at-reset:read", []).then(
          (value) => {
            if (live) setResumeAtReset(typeof value?.resumeAtReset === "boolean" ? value.resumeAtReset : null);
            return null;
          },
          () => {
            if (live) setResumeAtReset(null);
          },
        );
      return () => {
        live = false;
      };
    }, [session.client]),
  );
  async function changeResume() {
    if (!session.client || resumeAtReset === null || savingResume) return;
    setSavingResume(true);
    setResumeError("");
    try {
      const value = await session.client.call<{ resumeAtReset: boolean }>("limits:resume-at-reset:save", [!resumeAtReset]);
      setResumeAtReset(value.resumeAtReset);
    } catch (failure) {
      setResumeError(failure instanceof Error ? failure.message : "Could not change this setting.");
    } finally {
      setSavingResume(false);
    }
  }
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      if (!client) return;
      let live = true;
      client.call<{ autoSwitch: boolean } | null>("limits:auto-switch:read", []).then(
        (value) => live && setAutoSwitch(value ? value.autoSwitch === true : null),
        () => live && setAutoSwitch(null),
      );
      return () => {
        live = false;
      };
    }, [session.client]),
  );
  async function changeAutoSwitch(next: boolean) {
    const client = session.client;
    if (!client || autoSwitch === null) return;
    setAutoSwitchError("");
    setAutoSwitch(next);
    try {
      const value = await client.call<{ autoSwitch: boolean }>("limits:auto-switch:save", [next]);
      setAutoSwitch(value.autoSwitch === true);
    } catch (failure) {
      setAutoSwitch(!next);
      setAutoSwitchError(failure instanceof Error ? failure.message : "Could not change this setting.");
    }
  }
  if (!session.client || autoSwitch === null) return null;
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.section}>Usage limits</Text>
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle title="Switch accounts at usage limits" selected={autoSwitch} onPress={() => void changeAutoSwitch(!autoSwitch)} />
        <Text style={styles.caption}>When a Chat hits its plan&apos;s usage limit, move its Project to the next signed-in account and continue.</Text>
        {autoSwitchError ? <ErrorNotice message={autoSwitchError} /> : null}
      </View>
      {resumeAtReset !== null && (
        <View style={[styles.card, { gap: 4 }]}>
          <Toggle title="Continue when the limit resets" selected={resumeAtReset} disabled={savingResume} onPress={() => void changeResume()} />
          <Text style={styles.caption}>
            When a Chat hits its plan&apos;s usage limit and no other account can take over, continue it at the reset time, up to a day later.
          </Text>
          {resumeError ? <ErrorNotice message={resumeError} /> : null}
        </View>
      )}
    </View>
  );
}
