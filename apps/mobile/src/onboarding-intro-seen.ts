import { useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { hasPhoneKey } from "./phone-identity";

// Set once the intro has played or been skipped. A phone that has paired before (its pairing key exists) never sees it,
// even after forgetting every computer: the intro is for a first launch only, as on desktop.
const KEY = "milagre.onboarding-intro-seen.v1";

/** Whether to show the first-launch intro now: only on a booted phone with no computer, and only once. */
export function useFirstLaunchIntro(ready: boolean) {
  const [state, setState] = useState<"checking" | "show" | "hidden">("checking");
  useEffect(() => {
    if (!ready || state !== "checking") return;
    let live = true;
    void (async () => {
      const seen = await SecureStore.getItemAsync(KEY).catch(() => "1");
      const paired = await hasPhoneKey().catch(() => true);
      if (live) setState(!seen && !paired ? "show" : "hidden");
    })();
    return () => {
      live = false;
    };
  }, [ready, state]);
  const done = () => {
    setState("hidden");
    void SecureStore.setItemAsync(KEY, "1").catch(() => {});
  };
  return { show: state === "show", done } as const;
}
