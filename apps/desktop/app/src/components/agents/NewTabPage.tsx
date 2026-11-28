import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { IconSvgElement } from "@hugeicons/react";
import { closeTab, NEW_TAB_LABEL, newChatTabLabel, replaceTab, type TabPlace, type WorkspaceTab } from "@milagre/shared/workspace-tabs";
import { BubbleChatIcon } from "@hugeicons/core-free-icons";
import { updateTabSet } from "../../lib/workspace-tabs-store";
import { MenuRow } from "../primitives/Popover";
import { dockLayer, useDockArea } from "./dock-area";

export type Launch = { key: string; title: string; icon: IconSvgElement; shortcut?: string; detail?: string; onSelect: () => void };

type Entry = Omit<Launch, "onSelect"> & ({ tab: WorkspaceTab; onSelect?: () => void } | { tab?: undefined; onSelect: () => void });

/**
 * What a New tab offers: a New Chat here, then the strip's own entries. A pick with a tab of its own (the diff, the PR,
 * Paradise, the Artifact) takes the New tab's place; the rest close it and open through their panel, which adds their tab.
 */
export function newTabLaunches({
  workspace,
  blank,
  place,
  menu,
  onNewChat,
}: {
  workspace: string;
  blank: string;
  place: TabPlace;
  menu: readonly Entry[];
  onNewChat: () => void;
}): Launch[] {
  const drop = () => updateTabSet(workspace, (current) => closeTab(current, blank));
  return [
    {
      key: "chat",
      title: newChatTabLabel(place),
      icon: BubbleChatIcon,
      onSelect: () => {
        drop();
        onNewChat();
      },
    },
    ...menu.map(({ tab, onSelect, ...entry }) => ({
      ...entry,
      onSelect: () => {
        if (tab) return updateTabSet(workspace, (current) => replaceTab(current, blank, tab));
        drop();
        onSelect?.();
      },
    })),
  ];
}

/**
 * The page a New tab shows, as Paseo's does: what the tab can become, one row each, picked by click or by the arrow keys
 * and Return. It fills the workspace like a page tab in front.
 */
export function NewTabPage({ launches }: { launches: readonly Launch[] }) {
  const dock = useDockArea();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  const move = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[(at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  return createPortal(
    <section
      aria-label={NEW_TAB_LABEL}
      data-new-tab-page
      style={{ top: dock?.top ?? 40, left: dock?.left ?? 0, right: (dock?.right ?? 0) + 12, bottom: dock?.bottom ?? 12 }}
      className="fixed z-[41] flex items-center justify-center rounded-window bg-surface text-ink shadow-card"
    >
      <div ref={list} role="menu" aria-label={NEW_TAB_LABEL} onKeyDown={move} className="flex w-full max-w-[380px] flex-col gap-0.5 px-4">
        {launches.map((launch) => (
          <MenuRow
            key={launch.key}
            icon={launch.icon}
            title={launch.title}
            data-new-tab-launch={launch.key}
            trailing={
              (launch.shortcut || launch.detail) && <span className="max-w-[160px] truncate text-12 text-ink-3">{launch.shortcut ?? launch.detail}</span>
            }
            onClick={launch.onSelect}
            className="h-10"
          />
        ))}
      </div>
    </section>,
    dockLayer(),
  );
}
