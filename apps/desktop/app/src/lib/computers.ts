import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ComputersSnapshot, ComputerView } from "../electron.d.ts";
import { LOCAL_COMPUTER, computerOfKey, presenceTone } from "@milagre/shared/chat-scopes";
import { getSettings, updateSettings, useSettings } from "./settings.ts";
import { computersSnapshot, subscribeComputers } from "./computers-store.ts";
import { readHiddenComputers, subscribeHiddenComputers } from "./hidden-projects.ts";

export function useApplyOtherComputers() {
  const { otherComputers } = useSettings();
  const initialized = useRef(false);
  useEffect(() => {
    const sync = () => {
      const { enabled } = computersSnapshot();
      if (typeof enabled === "boolean" && getSettings().otherComputers !== enabled) updateSettings({ otherComputers: enabled });
    };
    const stop = subscribeComputers(sync);
    sync();
    return stop;
  }, []);
  useEffect(() => {
    const api = window.milagre?.computers;
    if (!api?.list || !api.setEnabled) return;
    let live = true;
    const before = computersSnapshot();
    void api
      .list()
      .then(async (next) => {
        if (!live) return;
        if (computersSnapshot() !== before && typeof computersSnapshot().enabled === "boolean") {
          initialized.current = true;
          return;
        }
        if (!initialized.current) {
          initialized.current = true;
          if (typeof next?.enabled === "boolean") {
            updateSettings({ otherComputers: next.enabled });
            return;
          }
        }
        if (next?.enabled !== otherComputers) await api.setEnabled(otherComputers);
        return;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [otherComputers]);
}

export type ComputerTone = "online" | "connecting" | "offline" | "refused";
const DOT_VAR = { green: "var(--green)", orange: "var(--orange)", red: "var(--red)", ink4: "var(--ink-4)" } as const;
export const DOT_COLOR: Record<ComputerTone, string> = {
  online: DOT_VAR[presenceTone("online")],
  connecting: DOT_VAR[presenceTone("connecting")],
  offline: DOT_VAR[presenceTone("offline")],
  refused: DOT_VAR[presenceTone("refused")],
};

export function computerTone({ state }: Pick<ComputerView, "state">): ComputerTone {
  if (state === "online") return "online";
  if (state === "connecting" || state === "reconnecting") return "connecting";
  if (state === "refused") return "refused";
  return "offline";
}

export function seenAgo(lastSeen: number | null, now: number): string | null {
  if (lastSeen === null || !Number.isFinite(lastSeen)) return null;
  const minutes = Math.max(0, Math.floor((now - lastSeen) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function routeLine(view: ComputerView, now: number): string {
  switch (view.state) {
    case "online":
      return view.route === "lan" ? "Same network" : view.relayHost;
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return view.message ?? "Reconnecting…";
    case "offline": {
      const ago = seenAgo(view.lastSeen, now);
      return ago ? `Offline, seen ${ago}` : "Offline";
    }
    case "refused":
      return view.message ?? "Pair again with a new link.";
    default:
      return "Off";
  }
}

export const settingsTooltip = (name: string) => `${name} settings: rename, connection, remove`;
export const isDimmed = (view: ComputerView | undefined) => view?.state === "offline" || view?.state === "refused";
export const isReadOnly = (view: ComputerView | undefined) =>
  !view || !(view.state === "online" || view.state === "connecting" || view.state === "reconnecting");

export function offlineBanner(view: ComputerView, now: number): string {
  const ago = seenAgo(view.lastSeen, now);
  return `${view.name} is offline. This is the last copy it sent${ago ? `, ${ago}` : ""}. What you send waits on this Mac until ${view.name} is back.`;
}
export const offlinePlaceholder = (name: string) => `Queue a message for ${name}…`;
export const reconnectingPlaceholder = (name: string) => ` (reconnecting to ${name}…)`;

const offViews = new WeakMap<ComputersSnapshot, ComputersSnapshot>();
function offView(current: ComputersSnapshot): ComputersSnapshot {
  let view = offViews.get(current);
  if (!view) offViews.set(current, (view = { thisMac: current.thisMac, computers: [] }));
  return view;
}

export function useComputers(): ComputersSnapshot {
  const { otherComputers } = useSettings();
  const current = useSyncExternalStore(subscribeComputers, computersSnapshot);
  return otherComputers ? current : offView(current);
}

const NONE_HIDDEN: ReadonlySet<string> = new Set();
export function useHiddenComputers(): ReadonlySet<string> {
  const { otherComputers } = useSettings();
  const hidden = useSyncExternalStore(subscribeHiddenComputers, readHiddenComputers);
  return otherComputers ? hidden : NONE_HIDDEN;
}

export function withComputer(key: string, subtitle: string): string {
  const id = computerOfKey(key);
  if (id === LOCAL_COMPUTER) return subtitle;
  const name = computersSnapshot().computers.find((computer) => computer.id === id)?.name ?? "Computer";
  return subtitle ? `${name} · ${subtitle}` : name;
}

export const computerNameOf = (computerId: string): string => computersSnapshot().computers.find((computer) => computer.id === computerId)?.name ?? "Computer";

export const computerAddressOf = (computerId: string | null | undefined): string | null =>
  !computerId || computerId === LOCAL_COMPUTER ? null : (computersSnapshot().computers.find((computer) => computer.id === computerId)?.address ?? null);
