import { useEffect } from "react";
import { router, useNavigation } from "expo-router";
import { UpdateSheet, useAppUpdates } from "../update-sheet";

export default function AppUpdateSheet() {
  const { state, check, install, dismiss } = useAppUpdates();
  const navigation = useNavigation();
  // Swipe and Android back defer the prompt; notification stack resets keep it pending.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (event.data.action.type === "GO_BACK" || event.data.action.type === "POP") dismiss();
      }),
    [navigation, dismiss],
  );
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
