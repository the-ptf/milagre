import { Stack } from "expo-router";
import { Text, View } from "react-native";
import { useStyles } from "../../ui";
import { SettingsScroll } from "../../settings-find";
import { LinearSection } from "../../linear-section";

/** Settings › Connections: services the Mac signs in to, like desktop's Connections section. Linear first; more to come. */
export default function ConnectionsScreen() {
  const styles = useStyles();
  return (
    <>
      <Stack.Screen options={{ title: "Connections" }} />
      <SettingsScroll>
        <View style={{ gap: 8 }}>
          <Text style={styles.section}>Issue trackers</Text>
          <LinearSection />
        </View>
      </SettingsScroll>
    </>
  );
}
