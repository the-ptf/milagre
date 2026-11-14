import { Text, View } from "react-native";
import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { Toggle, useStyles } from "../../ui";
import { UsageSection } from "../../usage-section";
import { UsageTabs } from "../../usage-tabs";
import { useUsageButtonShown } from "../../usage-button-setting";

export default function UsageScreen() {
  const styles = useStyles();
  const [usageButton, setUsageButton] = useUsageButtonShown();
  return (
    <>
      <Stack.Screen options={{ title: "Usage" }} />
      <SettingsScroll>
        <UsageSection header navigation={<UsageTabs value="plan" />} />
        {/* On this phone only: its sidebar has no meters, so desktop's Button or Off. */}
        <View style={styles.card}>
          <Toggle title="Show in sidebar" selected={usageButton} onPress={() => setUsageButton(!usageButton)} />
          <Text style={styles.muted}>A button beside Filters shows every provider&apos;s limits.</Text>
        </View>
      </SettingsScroll>
    </>
  );
}
