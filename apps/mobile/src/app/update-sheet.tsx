import { router } from "expo-router";
import { UpdateSheet, useAppUpdates } from "../update-sheet";

export default function AppUpdateSheet() {
  const { state, check, install, dismiss } = useAppUpdates();
  // Swipe and Android back defer the prompt; UpdateShell tells them apart from notification stack resets.
  return (
    <UpdateSheet
      state={state}
      onUpdate={() => void install()}
      onRetry={() => void check(true)}
      onNotes={() => {
        dismiss();
        router.push("/update-notes");
      }}
      onDismiss={() => {
        dismiss();
        router.back();
      }}
    />
  );
}
