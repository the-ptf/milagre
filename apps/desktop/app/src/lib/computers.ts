import { useEffect, useSyncExternalStore } from "react";
import type { ComputersSnapshot, ComputerView } from "../electron.d.ts";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import { useSettings } from "./settings.ts";
import { computersSnapshot, subscribeComputers } from "./computers-store.ts";
import { readHiddenComputers, subscribeHiddenComputers } from "./hidden-projects.ts";

/**
 * Tells main whether to connect the saved computers: at launch, and each time Settings › Devices › Other computers
 * flips. A window without the API (a check's fixture) is left alone.
 */
export function useApplyOtherComputers() {
  const { otherComputers } = useSettings();
  useEffect(() => {
    void Promise.resolve(window.milagre?.computers?.setEnabled?.(otherComputers)).catch(() => {});
  }, [otherComputers]);
}

export type ComputerTone = "online" | "connecting" | "offline" | "refused";
/** The status dot (design sidebar-c-sections v6): green online, amber while it connects, grey offline, red refused. */
export const DOT_COLOR: Record<ComputerTone, string> = {
  online: "var(--green)",
  connecting: "var(--orange)",
  offline: "var(--ink-3)",
  refused: "var(--red)",
};

export function computerTone({ state }: Pick<ComputerView, "state">): ComputerTone {
  if (state === "online") return "online";
  if (state === "connecting" || state === "reconnecting") return "connecting";
  if (state === "refused") return "refused";
  return "offline";
}

/** "just now", "5 min ago", "2h ago", "3d ago"; null when it was never seen. */
export function seenAgo(lastSeen: number | null, now: number): string | null {
  if (lastSeen === null || !Number.isFinite(lastSeen)) return null;
  const minutes = Math.max(0, Math.floor((now - lastSeen) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The popover's second line under a computer's name (spec "Computer status"). */
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
/** Its Projects and rows are dimmed (spec "Sidebar"). */
export const isDimmed = (view: ComputerView | undefined) => view?.state === "offline" || view?.state === "refused";
/** Nothing can be sent to it: the composer is disabled and sends are refused. */
export const isReadOnly = (view: ComputerView | undefined) => view?.state !== "online";

/** The banner over an offline computer's chat (design sidebar-c-sections v3). */
export function offlineBanner(view: ComputerView, now: number): string {
  const ago = seenAgo(view.lastSeen, now);
  return `${view.name} is offline. This is the last copy it sent${ago ? `, ${ago}` : ""}. You can read it until ${view.name} is back.`;
}
/** Appended to the composer's placeholder while its computer is offline. */
export const offlinePlaceholder = (name: string) => ` (${name} is offline)`;

// What useComputers shows while Other computers is off: this Mac's name only, one object per snapshot.
const offViews = new WeakMap<ComputersSnapshot, ComputersSnapshot>();
function offView(current: ComputersSnapshot): ComputersSnapshot {
  let view = offViews.get(current);
  if (!view) offViews.set(current, (view = { thisMac: current.thisMac, computers: [] }));
  return view;
}

/** This Mac's name and its computers; none while Settings › Devices › Other computers is off. */
export function useComputers(): ComputersSnapshot {
  const { otherComputers } = useSettings();
  const current = useSyncExternalStore(subscribeComputers, computersSnapshot);
  return otherComputers ? current : offView(current);
}

const NONE_HIDDEN: ReadonlySet<string> = new Set();
/**
 * The computers whose Projects the sidebar leaves out (unchecked in the computers popover); none while Other computers
 * is off, so This Mac can't stay hidden with no popover left to show it again.
 */
export function useHiddenComputers(): ReadonlySet<string> {
  const { otherComputers } = useSettings();
  const hidden = useSyncExternalStore(subscribeHiddenComputers, readHiddenComputers);
  return otherComputers ? hidden : NONE_HIDDEN;
}

/** A completion notice's subtitle: a remote chat's computer first, as main labels its waiting notices. */
export function withComputer(key: string, subtitle: string): string {
  const id = computerOfKey(key);
  if (id === LOCAL_COMPUTER) return subtitle;
  const name = computersSnapshot().computers.find((computer) => computer.id === id)?.name ?? "Computer";
  return subtitle ? `${name} · ${subtitle}` : name;
}

/** The name a computer is shown by, "Computer" when it is gone from the list. */
export const computerNameOf = (computerId: string): string => computersSnapshot().computers.find((computer) => computer.id === computerId)?.name ?? "Computer";

/** Where this Mac reaches a computer's own servers (the IP its LAN route dialed); null for this Mac, over the relay or offline. */
export const computerAddressOf = (computerId: string | null | undefined): string | null =>
  !computerId || computerId === LOCAL_COMPUTER ? null : (computersSnapshot().computers.find((computer) => computer.id === computerId)?.address ?? null);
