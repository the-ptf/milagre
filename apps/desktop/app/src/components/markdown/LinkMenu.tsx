import { createContext, useContext, type MouseEvent as ReactMouseEvent } from "react";
import { associatedPullRequest } from "@milagre/shared/chats";
import type { IconSvgElement } from "@hugeicons/react";
import {
  BrowserIcon,
  CodeIcon,
  Copy01Icon,
  File01Icon,
  Folder01Icon,
  GitPullRequestIcon,
  LinkSquare02Icon,
  SourceCodeIcon,
  TextIcon,
} from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ContextMenu, type ContextMenuEntry } from "../primitives/ContextMenu";
import { useFileOpener, useFilesRoot } from "../editor-links";
import { linkMenuEntries, markdownLink, type LinkMenuKey } from "../../lib/link-menu";
import { useSettings } from "../../lib/settings";
import { fileManager, isMac } from "../../lib/shortcut-hints";
import { hasBrowserPanel, openInBrowserPanel } from "../../lib/browser-panel";
import { showNotice } from "../../lib/notice";
import { isRemoteKey, useScope } from "../../lib/computer-bridge";

/** Opens a PR link in Code review when the Chat knows that PR; null for any other link. */
export type PullRequestLink = (url: string) => (() => void) | null;
export const PullRequestLinkContext = createContext<PullRequestLink | undefined>(undefined);

export function chatPullRequestLink<T extends { url: string }>(choices: readonly T[], open: (pr: T) => void): PullRequestLink {
  return (url) => {
    const pr = associatedPullRequest(url, choices);
    return pr ? () => open(pr) : null;
  };
}

/** A plain click on a known PR link in the transcript opens Code review instead of the browser. */
export function openPullRequestOnClick(event: ReactMouseEvent, pullRequestLink: PullRequestLink | undefined) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = event.target instanceof Element ? event.target.closest("a[href]")?.getAttribute("href") : null;
  const open = href ? pullRequestLink?.(href) : null;
  if (!open) return;
  event.preventDefault();
  event.stopPropagation();
  open();
}

export type LinkMenuTarget =
  | { kind: "web"; href: string; reachable: string; text: string }
  | { kind: "file"; path: string; line?: number; openViewer: () => void };

const ICONS: Record<LinkMenuKey, IconSvgElement> = {
  review: GitPullRequestIcon,
  panel: BrowserIcon,
  browser: LinkSquare02Icon,
  "copy-link": Copy01Icon,
  "copy-markdown": TextIcon,
  viewer: File01Icon,
  editor: CodeIcon,
  reveal: Folder01Icon,
  "copy-path": Copy01Icon,
  "copy-relative-path": SourceCodeIcon,
};

const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => showNotice("Couldn't copy to the clipboard."));

function relativeTo(root: string | null, file: string) {
  if (!root) return null;
  const base = root.replace(/[\\/]+$/, "");
  return file.startsWith(`${base}/`) || file.startsWith(`${base}\\`) ? file.slice(base.length + 1) : null;
}

export function LinkMenu({ target, position, onClose }: { target: LinkMenuTarget; position: { x: number; y: number }; onClose: (refocus: boolean) => void }) {
  const pullRequestLink = useContext(PullRequestLinkContext);
  const { openLinksIn } = useSettings();
  const opener = useFileOpener();
  const root = useFilesRoot();
  const remote = isRemoteKey(useScope());
  const platform = { mac: isMac, fileManager };

  const web = target.kind === "web" ? target : null;
  const review = web ? (pullRequestLink?.(web.href) ?? null) : null;
  const relative = target.kind === "file" ? relativeTo(root, target.path) : null;
  const rows = linkMenuEntries(
    web
      ? { kind: "web", pullRequest: Boolean(review), openLinksIn, panel: /^https?:\/\//i.test(web.reachable) && hasBrowserPanel() }
      : { kind: "file", editor: opener?.name, remote, relative: Boolean(relative) },
    platform,
  );

  const actions: Record<LinkMenuKey, () => void> = {
    review: () => review?.(),
    panel: () => web && !openInBrowserPanel(remote ? web.href : web.reachable) && window.open(web.reachable, "_blank", "noreferrer"),
    browser: () => web && window.open(web.reachable, "_blank", "noreferrer"),
    "copy-link": () => web && copy(web.reachable),
    "copy-markdown": () => web && copy(markdownLink(web.text === web.href ? web.reachable : web.text, web.reachable)),
    viewer: () => target.kind === "file" && target.openViewer(),
    editor: () => target.kind === "file" && opener?.open(relative ?? target.path, target.line),
    reveal: () =>
      target.kind === "file" && root && void window.milagre.revealFile(root, target.path).catch((error: unknown) => showNotice(ipcErrorMessage(error))),
    "copy-path": () => target.kind === "file" && copy(target.line ? `${target.path}:${target.line}` : target.path),
    "copy-relative-path": () => target.kind === "file" && relative && copy(target.line ? `${relative}:${target.line}` : relative),
  };

  const entries: ContextMenuEntry[] = [
    { heading: "Open in" },
    ...rows.map((row): ContextMenuEntry => (row === "divider" ? row : { ...row, icon: ICONS[row.key], onSelect: actions[row.key] })),
  ];

  const shown = target.kind === "file" ? (relative ?? target.path) : "";
  const header = web ? web.reachable : target.kind === "file" && target.line ? `${shown}:${target.line}` : shown;
  return <ContextMenu position={position} label={web ? "Link options" : "File link options"} header={header} entries={entries} onClose={onClose} />;
}
