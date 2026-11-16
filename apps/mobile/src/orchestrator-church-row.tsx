import { Text, View } from "react-native";
import { router } from "expo-router";
import { useSession } from "./session";
import { Row } from "./settings-list";
import { useStyles } from "./ui";
import { useOrchestrator } from "./use-orchestrator";

/** Settings › Church: the Orchestrator's own row, On or Off, opening its page. */
export function OrchestratorChurchRow() {
  const styles = useStyles();
  const { snapshot } = useOrchestrator(useSession().client);
  if (!snapshot) return null;
  return (
    <View style={[styles.card, { gap: 4, paddingVertical: 4 }]}>
      <Row title="Orchestrator" value={snapshot.settings.enabled ? "On" : "Off"} onPress={() => router.push("/orchestrator-settings")} />
      <Text style={[styles.caption, { paddingBottom: 12 }]}>
        One box pinned atop the Chats list. It sends any prompt to the right Project, model and account, runs it as a Subchat and tracks it on a board.
      </Text>
    </View>
  );
}
