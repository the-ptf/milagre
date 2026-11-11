import { useState } from "react";
import { FolderOpenIcon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { OpenProject } from "../model";
import { bridgeFor } from "../lib/computer-bridge";
import { RECENT_PROJECTS_CHANGED, type SubprojectScan } from "../lib/project-list";
import { updateSettings, useSettings } from "../lib/settings";
import { subprojectsLayout } from "@milagre/shared/chat-display";
import { Button } from "./primitives/Button";
import { Checkbox } from "./primitives/Checkbox";
import { Dialog } from "./primitives/Dialog";
import { EmptyState } from "./primitives/EmptyState";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { ScrollArea } from "./primitives/ScrollArea";

/**
 * Choose a Parent Project's Sub-projects: the repositories and folders inside it, as a checklist. Adding a folder offers
 * it with every repository checked, and "Open as one Project" skips the grouping; editing a Parent Project starts from
 * the ones it has. Mounted only while open.
 */
export function SubprojectsDialog({
  scan,
  adding,
  onClose,
  onOpenSingle,
  onSave,
}: {
  scan: SubprojectScan;
  /** Add Project's step: the folder isn't a Project yet. */
  adding: boolean;
  onClose: () => void;
  onOpenSingle?: () => Promise<void>;
  onSave: (paths: string[]) => Promise<void>;
}) {
  const choices = scan.children;
  const [selected, setSelected] = useState<string[]>(() => choices.filter((child) => child.chosen).map((child) => child.path));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = scan.folder.split("/").findLast(Boolean) ?? scan.folder;
  // In the scan's order, whatever order they were checked in.
  const chosen = choices.map((child) => child.path).filter((path) => selected.includes(path));
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(ipcErrorMessage(cause));
      setBusy(false);
    }
  }
  const allChecked = choices.length > 0 && chosen.length === choices.length;
  return (
    <Dialog
      data-subprojects-dialog
      title={adding ? `Add ${name}` : `Sub-projects of ${name}`}
      description={
        adding
          ? `${name} holds ${choices.filter((child) => child.git).length} repositories. Add it as a Parent Project with the ones you check as its Sub-projects, each with its own Worktrees and Chats.`
          : "Each checked folder is listed under this Project in the sidebar, with its own Worktrees and Chats."
      }
      onClose={onClose}
      width={520}
      footer="bar"
      footerStart={
        adding && onOpenSingle ? (
          <Button variant="ghost" disabled={busy} onClick={() => void run(onOpenSingle)}>
            Open as one Project
          </Button>
        ) : undefined
      }
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button data-subprojects-save disabled={busy || (adding && !chosen.length)} onClick={() => void run(() => onSave(chosen))}>
            {adding ? `Add with ${chosen.length} Sub-project${chosen.length === 1 ? "" : "s"}` : "Save"}
          </Button>
        </>
      }
    >
      {choices.length > 0 && (
        <label className="mt-4 flex items-center gap-2 px-2 text-12 text-ink-3">
          <Checkbox
            checked={allChecked ? true : chosen.length ? "indeterminate" : false}
            disabled={busy}
            onCheckedChange={(checked) => setSelected(checked ? choices.map((child) => child.path) : [])}
          />
          {chosen.length} of {choices.length} selected
        </label>
      )}
      <ScrollArea aria-label="Folders" className="mt-2 max-h-[320px] min-h-0 rounded-control border border-line p-1">
        {choices.map((child) => (
          <label
            key={child.path}
            data-subproject={child.relative}
            className="flex h-11 items-center gap-2 rounded-control px-2 transition-colors hover:bg-hover"
          >
            <Checkbox
              checked={selected.includes(child.path)}
              disabled={busy}
              onCheckedChange={(checked) => setSelected((current) => (checked ? [...current, child.path] : current.filter((path) => path !== child.path)))}
            />
            <Icon icon={child.git ? GitBranchIcon : FolderOpenIcon} size={16} className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-13 font-medium" title={child.path}>
                {child.name}
              </span>
              {child.relative !== child.name && <span className="block truncate text-11 text-ink-3">{child.relative}</span>}
            </span>
            <span className="shrink-0 text-11 text-ink-3">{child.git ? "git" : "folder"}</span>
          </label>
        ))}
        {!choices.length && <EmptyState size="compact" title="No folders inside" />}
      </ScrollArea>
      <InlineError size={12} className="mt-3 whitespace-pre-wrap">
        {error}
      </InlineError>
    </Dialog>
  );
}

/**
 * Opening a folder on this Mac, as Add Project and onboarding do: one with repositories inside first asks which become
 * its Sub-projects (Settings › Worktrees › Detect Sub-projects can turn that off); any other opens at once. `dialog` is
 * that question while it is asked.
 */
export function useOpenFolder(onOpened: (project: OpenProject) => void, onCancel?: () => void) {
  const [scan, setScan] = useState<SubprojectScan | null>(null);
  const { chatList } = useSettings();
  const bridge = bridgeFor(null);
  async function open(folder: string) {
    const found = await bridge.scanSubprojects(folder).catch(() => null);
    // A repository with repositories inside (submodules, a monorepo) opens as one Project; Sub-projects… can still group it.
    if (found?.detect && !found.git && found.children.some((child) => child.git)) setScan(found);
    else onOpened(await bridge.openProjectAt(folder));
  }
  const dialog = scan && (
    <SubprojectsDialog
      scan={scan}
      adding
      onClose={() => {
        setScan(null);
        onCancel?.();
      }}
      onOpenSingle={async () => onOpened(await bridge.openProjectAt(scan.folder))}
      onSave={async (paths) => {
        const opened = await bridge.openProjectAt(scan.folder);
        await bridge.setSubprojects(opened.path, paths);
        // The Sub-projects layout is what draws a Parent Project: it comes on with the first one.
        const layout = subprojectsLayout(chatList);
        if (layout && paths.length) updateSettings({ chatList: layout });
        window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
        onOpened(opened);
      }}
    />
  );
  return { open, dialog };
}
