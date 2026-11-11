import { useState } from "react";
import { FolderOpenIcon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import { treeLayout } from "@milagre/shared/chat-display";
import type { FolderScan } from "@milagre/shared/project-list";
import type { OpenProject } from "../model";
import { bridgeFor } from "../lib/computer-bridge";
import { RECENT_PROJECTS_CHANGED } from "../lib/project-list";
import { updateSettings, useSettings } from "../lib/settings";
import { Button } from "./primitives/Button";
import { Checkbox } from "./primitives/Checkbox";
import { Dialog } from "./primitives/Dialog";
import { EmptyState } from "./primitives/EmptyState";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { ScrollArea } from "./primitives/ScrollArea";

const folderName = (folder: string) => folder.split("/").findLast(Boolean) ?? folder;

/**
 * Adding a folder that holds repositories: a checklist of them (repositories checked, other folders not). The checked
 * ones open as Projects and, two or more, get a Named Link named after the folder, which the Tree layout draws with them
 * under it. "Open as one Project" opens the folder itself instead. Mounted only while open.
 */
export function ImportFolderDialog({
  scan,
  onClose,
  onOpenSingle,
  onAdd,
}: {
  scan: FolderScan;
  onClose: () => void;
  onOpenSingle: () => Promise<void>;
  onAdd: (paths: string[]) => Promise<void>;
}) {
  const choices = scan.children;
  const [selected, setSelected] = useState<string[]>(() => choices.filter((child) => child.chosen).map((child) => child.path));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = folderName(scan.folder);
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
      data-import-folder-dialog
      title={`Add ${name}`}
      description={`${name} holds ${choices.filter((child) => child.git).length} repositories. Add the ones you check as Projects, grouped by a Link named ${name}.`}
      onClose={onClose}
      width={520}
      footer="bar"
      footerStart={
        <Button variant="ghost" disabled={busy} onClick={() => void run(onOpenSingle)}>
          Open as one Project
        </Button>
      }
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button data-import-folder-add disabled={busy || !chosen.length} onClick={() => void run(() => onAdd(chosen))}>
            {`Add ${chosen.length} Project${chosen.length === 1 ? "" : "s"}`}
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
            data-import-folder-item={child.relative}
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
 * Opening a folder on this Mac, as Add Project and onboarding do. A folder that holds repositories (and isn't one)
 * first asks which to add (Settings › Worktrees › Detect repositories in a folder can turn that off); they open as
 * Projects with a Named Link that groups them, and the Tree layout comes on to draw it. Any other folder opens at once.
 * `dialog` is that question while it is asked.
 */
export function useOpenFolder(onOpened: (project: OpenProject) => void, onCancel?: () => void) {
  const [scan, setScan] = useState<FolderScan | null>(null);
  const { chatList } = useSettings();
  const bridge = bridgeFor(null);
  async function open(folder: string) {
    const found = await bridge.scanFolder(folder).catch(() => null);
    if (found?.detect && !found.git && found.children.some((child) => child.git)) setScan(found);
    else onOpened(await bridge.openProjectAt(folder));
  }
  async function add(folder: string, paths: string[]) {
    const opened: OpenProject[] = [];
    for (const path of paths) opened.push(await bridge.openProjectAt(path));
    if (opened.length > 1) {
      const registered = await bridge.listProjects();
      const projectIds = opened.map((project) => registered.find((entry) => entry.path === project.path)?.id).filter((id): id is string => !!id);
      if (projectIds.length > 1) await bridge.createNamedLink({ name: folderName(folder), projectIds });
      const layout = treeLayout(chatList);
      if (layout) updateSettings({ chatList: layout });
    }
    window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
    onOpened(opened[0]!);
  }
  const dialog = scan && (
    <ImportFolderDialog
      scan={scan}
      onClose={() => {
        setScan(null);
        onCancel?.();
      }}
      onOpenSingle={async () => onOpened(await bridge.openProjectAt(scan.folder))}
      onAdd={(paths) => add(scan.folder, paths)}
    />
  );
  return { open, dialog };
}
