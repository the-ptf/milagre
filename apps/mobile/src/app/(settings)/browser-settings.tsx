import { useState } from "react";
import { Text, View } from "react-native";
import { Stack } from "expo-router";
import { useInternalBrowser } from "../../browser-setting";
import { BrowserSignInsSection } from "../../browser-sign-ins-section";
import { ErrorNotice, PageScroll, Toggle, useStyles } from "../../ui";

export default function BrowserSettingsScreen() {
  const styles = useStyles();
  const [internalBrowser, setInternalBrowser] = useInternalBrowser();
  const [browserError, setBrowserError] = useState("");
  return (
    <>
      <Stack.Screen options={{ title: "Browser" }} />
      <PageScroll>
        <Text style={[styles.section, { marginTop: 12 }]}>Browser on this device</Text>
        <View style={[styles.card, { gap: 4 }]}>
          <Toggle
            title="Open links in Milagre"
            selected={internalBrowser}
            onPress={() => {
              setBrowserError("");
              void setInternalBrowser(!internalBrowser).catch(() => setBrowserError("Could not save this setting. Try again."));
            }}
          />
          <Text style={styles.caption}>{"Open web links in this Chat's Browser. Turn off to use this device's default browser."}</Text>
          {browserError ? <ErrorNotice message={browserError} /> : null}
        </View>
        <BrowserSignInsSection />
      </PageScroll>
    </>
  );
}
