import { useMemo } from "react";
import type { UsageInSidebar } from "@milagre/shared/usage";
import { visibleProviders } from "./format";
import { SidebarUsage } from "./SidebarUsage";
import { UsageButton } from "./UsageButton";
import type { UsageState } from "./useUsage";

export function useSidebarUsage(shown: UsageInSidebar, usage: UsageState, scope: string | undefined, chatsHome: boolean) {
  const { snapshot, loading, refresh, refreshIfStale } = usage;
  const has = Boolean(snapshot && visibleProviders(snapshot).length > 0);
  const state = useMemo(() => ({ snapshot, loading, refresh, refreshIfStale }), [snapshot, loading, refresh, refreshIfStale]);
  const sidebarUsage = useMemo(
    () => (shown === "meters" && has ? <SidebarUsage usage={state} scope={scope} chatsHome={chatsHome} /> : undefined),
    [shown, has, state, scope, chatsHome],
  );
  const sidebarUsageButton = useMemo(
    () => (shown === "button" && has ? <UsageButton usage={state} scope={scope} chatsHome={chatsHome} /> : undefined),
    [shown, has, state, scope, chatsHome],
  );
  return { sidebarUsage, sidebarUsageButton };
}
