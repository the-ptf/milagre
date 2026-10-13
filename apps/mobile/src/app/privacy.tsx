import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { Stack } from "expo-router";
import { AI_CONSENT_DESCRIPTION, AI_CONSENT_DETAIL, AI_RESET_DETAIL, AI_PROVIDER_POLICIES, PRIVACY_URL, SUPPORT_URL } from "@milagre/shared/ai-consent";
import { aiConsent } from "../ai-consent";
import { ErrorNotice, ListRow, PageScroll, PillButton, useStyles } from "../ui";

export default function PrivacyScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Privacy & AI" }} />
      <PrivacyView />
    </>
  );
}

export function PrivacyView() {
  const styles = useStyles();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void aiConsent.allowed().then(setAllowed, () => setError("Could not read AI sharing permission. Unlock your phone and try again."));
  }, []);
  async function reset() {
    setBusy(true);
    setError("");
    try {
      await aiConsent.reset();
      setAllowed(false);
    } catch {
      setError("Could not reset AI sharing permission. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function open(url: string) {
    setError("");
    try {
      await Linking.openURL(url);
    } catch {
      setError(`Could not open this page. Visit ${url} in your browser.`);
    }
  }
  return (
    <PageScroll>
      <View style={styles.card}>
        <Text style={styles.subtitle}>Sharing with AI providers</Text>
        <Text style={styles.text}>{AI_CONSENT_DESCRIPTION}</Text>
        <Text style={styles.muted}>{AI_CONSENT_DETAIL}</Text>
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {allowed === null
            ? "Checking permission..."
            : allowed
              ? "AI sharing is allowed on this device."
              : "AI sharing will ask for permission before your next AI action."}
        </Text>
        <PillButton title="Reset AI sharing permission" secondary loading={busy} disabled={busy || allowed !== true} onPress={() => void reset()} />
        <Text style={styles.muted}>{AI_RESET_DETAIL}</Text>
      </View>
      {error ? <ErrorNotice message={error} /> : null}
      <View style={[styles.card, { paddingVertical: 4, gap: 0 }]}>
        {[{ name: "Milagre privacy policy", url: PRIVACY_URL }, ...AI_PROVIDER_POLICIES, { name: "Support", url: SUPPORT_URL }].map(({ name, url }) => (
          <ListRow key={url} title={name} onPress={() => void open(url)} />
        ))}
      </View>
    </PageScroll>
  );
}
