import { useLocalSearchParams } from "expo-router";
import { OrchestratorTaskSheet } from "../orchestrator-task-sheet";

export default function OrchestratorTaskScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <OrchestratorTaskSheet taskId={typeof id === "string" ? id : ""} />;
}
