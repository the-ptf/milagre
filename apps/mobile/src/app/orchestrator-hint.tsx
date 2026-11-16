import { useLocalSearchParams } from "expo-router";
import { OrchestratorHintSheet } from "../orchestrator-hint-sheet";

export default function OrchestratorHintScreen() {
  const { path = "", name = "" } = useLocalSearchParams<{ path?: string; name?: string }>();
  return <OrchestratorHintSheet path={path} name={name || path.split("/").findLast(Boolean) || "Project"} />;
}
