import { useEffect } from "react";
import { router, useNavigation } from "expo-router";
import { UpdateSheet, useAppUpdates } from "../update-sheet";

export default function AppUpdateSheet() {
  const { state, check, install, dismiss } = useAppUpdates();
  const navigation = useNavigation();
  // Swipe and Android back defer the prompt; notification stack resets keep it pending.
  useEffect(() => {
    const unsubscribe = navigation.addListener("removed", (event) => {
      if (event.data.action.type === "GO_BACK" || event.data.action.type === "POP") dismiss();
    });
    // "removed" fires after this screen unmounts, so the listener has to outlive the cleanup by a microtask.
    // Router delivers it before the container's state event, so UpdateShell defers before it would present again.
    return () => queueMicrotask(unsubscribe);
  }, [navigation, dismiss]);
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
