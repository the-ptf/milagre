import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import type { SimlockSettings, SimlockSettingsPatch } from "@milagre/shared/simulator";
import { useSession } from "./session";
import { Group } from "./settings-list";
import { useTheme } from "./theme";
import { ErrorNotice, Field, PillButton, Segmented, Toggle, useStyles } from "./ui";

const DEVICES = [1, 2, 3, 4, 6, 8].map((count) => ({ value: String(count), title: String(count) }));
const MINUTES = [15, 30, 60, 120, 240].map((minutes) => ({ value: String(minutes), title: minutes < 60 ? `${minutes} min` : `${minutes / 60} h` }));
const message = (error: unknown) => (error instanceof Error ? error.message : "Could not reach this Mac.");

/**
 * Settings › Experimental › Simlock devices, as on desktop: the connected Mac's pool. The agent token is sent once to the
 * Mac and never read back; the Mac keeps it for its own gateway.
 */
export function SimlockSection() {
  const styles = useStyles();
  const { colors } = useTheme();
  const client = useSession().client;
  const [settings, setSettings] = useState<SimlockSettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [gateway, setGateway] = useState(""),
    [token, setToken] = useState("");
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      let live = true;
      setLoadError("");
      client.call<SimlockSettings>("simlock:settings:read", []).then(
        (value) => {
          if (!live) return;
          setSettings(value);
          setGateway(value.savedGatewayUrl);
        },
        (cause) => live && setLoadError(message(cause)),
      );
      return () => {
        live = false;
      };
    }, [client]),
  );
  const save = async (patch: SimlockSettingsPatch) => {
    if (!client) return null;
    setSaving(true);
    setError("");
    try {
      const value = await client.call<SimlockSettings>("simlock:settings:save", [patch]);
      setSettings(value);
      return value;
    } catch (cause) {
      setError(message(cause));
      return null;
    } finally {
      setSaving(false);
    }
  };
  const connect = async () => {
    if (!client) return;
    const typed = gateway.trim();
    setCheck({ ok: true, text: "Checking the gateway..." });
    try {
      const who = await client.call<{ name: string; role: string; gatewayUrl: string }>("simlock:identity", [
        { ...(typed ? { gatewayUrl: typed } : {}), ...(token.trim() ? { agentToken: token.trim() } : {}) },
      ]);
      if (await save({ gatewayUrl: typed, ...(token.trim() ? { agentToken: token.trim() } : {}) })) setToken("");
      setCheck({ ok: true, text: `Connected to ${who.gatewayUrl} as ${who.name} (${who.role}).` });
    } catch (cause) {
      setCheck({ ok: false, text: message(cause) });
    }
  };
  if (!client) return <Text style={styles.muted}>Connect to a Mac to set up Simlock devices.</Text>;
  if (loadError) return <ErrorNotice message={`This Mac can't lease Simlock devices yet. Update Milagre on it. (${loadError})`} />;
  if (!settings) return <Text style={styles.muted}>Loading...</Text>;
  const detected = settings.detected;
  return (
    <View style={{ gap: 20 }}>
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle
          title="Simlock devices"
          selected={settings.enabled}
          disabled={saving}
          tint={colors.accent}
          onPress={() => void save({ enabled: !settings.enabled })}
        />
        <Text style={styles.caption}>
          Agents lease a simulator or emulator of their own from a Simlock pool, watch it here and on the Mac, and return it wiped. Simlock runs on your own
          Macs; Milagre doesn&apos;t install it.
        </Text>
      </View>
      {settings.enabled && (
        <>
          <Group title="Gateway">
            <View style={{ gap: 12, paddingVertical: 12 }}>
              <Field
                label="Gateway"
                hideLabel
                value={gateway}
                onChangeText={setGateway}
                placeholder={detected?.gatewayUrl ?? "https://gateway.example.ts.net:4700"}
                keyboardType="url"
                textContentType="URL"
              />
              <Text style={styles.caption}>
                {detected
                  ? `Leave it empty to use the Mac's ${detected.source === "worker" ? "Simlock worker" : "agent-device setup"} at ${detected.gatewayUrl}.`
                  : "A Simlock gateway or worker's address, such as https://gateway.example.ts.net:4700."}
              </Text>
              <Field
                label="Agent token"
                hideLabel
                value={token}
                onChangeText={setToken}
                secureTextEntry
                textContentType="password"
                placeholder={settings.tokenSource === "settings" ? "Saved" : settings.tokenSource ? "The Mac's Simlock token" : "slk_..."}
              />
              <Text style={styles.caption}>
                From simlock token create --role agent, one per Mac running Milagre. It stays on the Mac and goes only to its gateway.
              </Text>
            </View>
            <View style={{ gap: 12, paddingVertical: 12 }}>
              <PillButton title={saving ? "Saving..." : "Save and check"} disabled={saving} onPress={() => void connect()} />
              {check && (
                <Text accessibilityRole={check.ok ? undefined : "alert"} style={[styles.caption, !check.ok && { color: colors.redInk }]}>
                  {check.text}
                </Text>
              )}
              {settings.tokenSource === "settings" && (
                <PillButton title="Forget token" disabled={saving} onPress={() => void save({ agentToken: "" }).then(() => setCheck(null))} />
              )}
            </View>
          </Group>
          <Group title="Limits">
            <View style={{ gap: 8, paddingVertical: 12 }}>
              <Text style={{ color: colors.ink, fontSize: 17 }}>Devices at once</Text>
              <Segmented
                label="Devices at once"
                value={String(settings.maxLeases)}
                options={DEVICES}
                onChange={(value) => void save({ maxLeases: Number(value) })}
              />
              <Text style={styles.caption}>Leases this Mac holds together. Simlock also caps leases per token.</Text>
            </View>
            <View style={{ gap: 8, paddingVertical: 12 }}>
              <Text style={{ color: colors.ink, fontSize: 17 }}>Return a device after</Text>
              <Segmented
                label="Return a device after"
                value={String(settings.maxLeaseMinutes)}
                options={
                  MINUTES.some((option) => option.value === String(settings.maxLeaseMinutes))
                    ? MINUTES
                    : [...MINUTES, { value: String(settings.maxLeaseMinutes), title: `${settings.maxLeaseMinutes} min` }]
                }
                onChange={(value) => void save({ maxLeaseMinutes: Number(value) })}
              />
              <Text style={styles.caption}>A lease ends this long after it started, even while an agent uses it.</Text>
            </View>
          </Group>
        </>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={[styles.caption, { color: colors.redInk }]}>
          {error}
        </Text>
      )}
    </View>
  );
}
