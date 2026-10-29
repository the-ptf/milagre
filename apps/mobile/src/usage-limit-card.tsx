import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import type { ProjectAccountsSnapshot, UsageLimitContext, LimitResume } from "@milagre/shared/model";
import { limitChoices, limitHeadline, limitResumeLabel, switchedText } from "@milagre/shared/usage-limit";
import { Icon } from "./icons";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { ErrorNotice, PillButton } from "./ui";

/**
 * A reply the plan's usage limit stopped. It offers the Project's other accounts for the provider only while this is the
 * Chat's last message with no turn running (`projectPath` is set then); otherwise it is the headline alone.
 */
export function UsageLimitCard({
  limit,
  sessionId,
  projectPath,
  pending,
  sourceMessageId,
  resumeAvailable = false,
  resumeBlocked = false,
}: {
  limit: UsageLimitContext;
  sessionId: number;
  projectPath?: string;
  pending?: LimitResume;
  sourceMessageId?: number;
  resumeAvailable?: boolean;
  resumeBlocked?: boolean;
}) {
  const { colors } = useTheme();
  const session = useSession();
  const client = session.client;
  const [snapshot, setSnapshot] = useState<ProjectAccountsSnapshot | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switched, setSwitched] = useState("");
  const [error, setError] = useState("");
  const [resumeSupported, setResumeSupported] = useState(false);
  const request = useRef(0);
  const interactive = !!client && !!projectPath && !switched;
  useEffect(() => {
    let stale = false;
    if (interactive)
      void client.call<{ resumeAtReset: boolean }>("limits:resume-at-reset:read", []).then(
        (value) => {
          if (!stale) setResumeSupported(typeof value?.resumeAtReset === "boolean");
          return null;
        },
        () => {
          if (!stale) setResumeSupported(false);
        },
      );
    return () => {
      stale = true;
    };
  }, [client, interactive]);
  const load = useCallback(async () => {
    if (!client || !projectPath) return;
    const version = ++request.current;
    try {
      const value = await client.call<ProjectAccountsSnapshot>("accounts:scope", [projectPath, false]);
      if (version === request.current) setSnapshot(value);
    } catch {
      // The headline stays; the card offers no choices it could not load.
    }
  }, [client, projectPath]);
  const invalidate = useCallback(() => {
    request.current++;
  }, []);
  // This effect fetches the Project's accounts from the connected computer, again when they change on it.
  useEffect(() => {
    if (!interactive) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return invalidate;
  }, [interactive, load, invalidate, session.providerRevision]);
  const { title, detail } = limitHeadline(limit);
  const choices = interactive ? limitChoices(snapshot, limit) : [];
  const loaded = interactive && snapshot !== null;
  const resumeLabel = limitResumeLabel(pending, limit);
  async function changeResume() {
    if (!client || !projectPath || switching) return;
    setSwitching("resume");
    setError("");
    try {
      const changed = await client.call<boolean>(pending ? "chat:limit-resume:cancel" : "chat:limit-resume", [
        projectPath,
        sessionId,
        pending ? pending.sendId : sourceMessageId,
      ]);
      if (!changed && !pending) setError("This Chat can no longer continue at this reset time.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not change this continuation.");
    } finally {
      setSwitching(null);
    }
  }
  async function choose(accountId: string) {
    if (!client || !projectPath || switching) return;
    setSwitching(accountId);
    setError("");
    try {
      const result = await client.call<{ continued: boolean; label: string }>("chat:limit-switch", [projectPath, sessionId, limit.provider, accountId]);
      setSwitched(switchedText(result));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not switch accounts.");
    } finally {
      setSwitching(null);
    }
  }
  return (
    <View
      style={{
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 18,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: colors.surface,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ paddingTop: 2 }}>
          <Icon icon={Alert02Icon} tone="orange" size={16} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 15, fontWeight: "600", lineHeight: 20 }}>
            {title}
          </Text>
          <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 19 }}>{detail}</Text>
        </View>
      </View>
      {resumeLabel && !switched && (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          {pending && <Text style={{ color: colors.ink2, fontSize: 13 }}>{resumeLabel}</Text>}
          {interactive && resumeSupported && resumeAvailable && !resumeBlocked && (
            <PillButton title={pending ? "Cancel" : resumeLabel} disabled={!!switching} onPress={() => void changeResume()} />
          )}
        </View>
      )}
      {switched ? (
        <Text accessibilityRole="alert" style={{ color: colors.ink2, fontSize: 14, lineHeight: 19 }}>
          {switched}
        </Text>
      ) : (
        loaded && (
          <>
            {choices.length > 0 && (
              <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
                {choices.map((choice, index) => (
                  <Pressable
                    key={choice.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Switch to ${choice.label}${choice.detail ? `. ${choice.detail}` : ""}`}
                    accessibilityState={{ disabled: choice.disabled || !!switching, busy: switching === choice.id }}
                    disabled={choice.disabled || !!switching}
                    onPress={() => void choose(choice.id)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      minHeight: 48,
                      paddingVertical: 8,
                      borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
                      borderColor: colors.line,
                      opacity: choice.disabled ? 0.4 : pressed ? 0.5 : 1,
                    })}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 15, fontWeight: "500" }}>
                        {`Switch to ${choice.label}`}
                      </Text>
                      {!!choice.detail && (
                        <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 13 }}>
                          {choice.detail}
                        </Text>
                      )}
                    </View>
                    {switching === choice.id && <ActivityIndicator color={colors.ink2} />}
                  </Pressable>
                ))}
              </View>
            )}
            {choices.every((choice) => choice.disabled) && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <PillButton title={choices.length ? "Manage accounts" : "Add account"} secondary onPress={() => router.push("/accounts")} />
              </View>
            )}
          </>
        )
      )}
      {error ? <ErrorNotice message={error} /> : null}
    </View>
  );
}
