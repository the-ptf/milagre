import { useEffect } from "react";
import { startRefreshLoop } from "@milagre/shared/refresh-loop";

/** External tools never emit agent events. Keep visible Changes views current independently. */
export function useGitRefresh(active: boolean, identity: string, refresh: (background?: boolean) => Promise<void>) {
  useEffect(() => {
    if (!active) return;
    return startRefreshLoop({
      refresh: () => refresh(true),
      isActive: () => document.visibilityState === "visible",
      onActive(listener) {
        document.addEventListener("visibilitychange", listener);
        window.addEventListener("focus", listener);
        return () => {
          document.removeEventListener("visibilitychange", listener);
          window.removeEventListener("focus", listener);
        };
      },
    });
  }, [active, identity, refresh]);
}
