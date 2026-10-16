import { Stack } from "expo-router";
import { Text, View } from "react-native";
import { PageScroll, useStyles } from "../ui";
import { LinearSection } from "../linear-section";

/** Settings › Connections: services the Mac signs in to, like desktop's Connections section. Linear first; more to come. */
export default function ConnectionsScreen() {
  const styles = useStyles();
  return (
    <>
      <Stack.Screen options={{ title: "Connections" }} />
      <PageScroll>
        <View style={{ gap: 8 }}>
          <Text style={styles.section}>Issue trackers</Text>
          <LinearSection />
        </View>
      </PageScroll>
    </>
  );
}
