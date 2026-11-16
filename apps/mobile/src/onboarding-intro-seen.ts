import { useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { hasPhoneKey } from "./phone-identity";

const KEY = "milagre.onboarding-intro-seen.v1";

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
