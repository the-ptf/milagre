import type { IconSvgElement } from "@hugeicons/react";
import { Copy01Icon, FolderOpenIcon, LibraryIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { unqualifyKey } from "@milagre/shared/chat-scopes";
import { projectMenuActions, type ProjectMenuKey } from "../../lib/reveal";
import { isRemoteKey } from "../../lib/computer-bridge";
import { openDesignLibrary } from "../../lib/design-library-page";
import type { ScopeMenuItem } from "./ScopeHeader";

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
const ICONS: Record<ProjectMenuKey, IconSvgElement> = {
  reveal: FolderOpenIcon,
  "copy-path": Copy01Icon,
  "copy-name": Copy01Icon,
  "design-library": LibraryIcon,
  settings: Settings01Icon,
};

/** A Project's ⋯ menu in the sidebar, before Remove Project: reveal, copy, its Design library and its settings. */
export function projectMenu(scope: { key: string; name: string }, onOpenProjectSettings: ((key: string) => void) | undefined): ScopeMenuItem[] {
  const actions: Record<ProjectMenuKey, Pick<ScopeMenuItem, "run" | "disabled">> = {
    reveal: { run: () => void window.milagre?.revealInFolder(scope.key).catch(() => {}) },
    "copy-path": { run: () => copy(unqualifyKey(scope.key)) },
    "copy-name": { run: () => copy(scope.name) },
    "design-library": { run: () => openDesignLibrary(scope.key, scope.name) },
    settings: { run: () => onOpenProjectSettings?.(scope.key), disabled: !onOpenProjectSettings },
  };
  return projectMenuActions(IS_MAC)
    .filter((item) => item.key !== "reveal" || !isRemoteKey(scope.key))
    .map((item) => ({ key: item.key, label: item.label, icon: ICONS[item.key], ...actions[item.key] }));
}
