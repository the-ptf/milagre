import { useEffect, useRef, useState } from "react";
import { FolderOpenIcon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { DirListing } from "../electron";
import type { OpenProject } from "../model";
import { bridgeFor } from "../lib/computer-bridge";
import { DOT_COLOR, computerTone, routeLine, useComputers } from "../lib/computers";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { ScrollArea } from "./primitives/ScrollArea";

const THIS_MAC = "this-mac";

/**
 * Add project with other computers (design add-project-remote v1): choose the computer (offline ones disabled), then a
 * folder on it. This Mac keeps its folder dialog; another computer's home folder is browsed through fs:list-dirs and the
 * checkout opens there, whose daemon owns it. Mounted only while open.
 */
export function AddProjectDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (project: OpenProject) => void }) {
  const { thisMac, computers } = useComputers();
  const [on, setOn] = useState<string>(THIS_MAC);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [selected, setSelected] = useState<DirListing["entries"][number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reads = useRef(0);
  const computer = computers.find((item) => item.id === on);
  const reachable = computer?.state === "online";

  async function browse(path?: string) {
    if (!computer || !reachable) return;
    const read = ++reads.current;
    setSelected(null);
    setError(null);
    try {
      const next = await bridgeFor(computer.id).listDirs(path ? { path } : {});
      if (read === reads.current) setListing(next);
    } catch (cause) {
      if (read === reads.current) setError(ipcErrorMessage(cause));
    }
  }
  useEffect(() => {
    // A new computer drops what the last one was reading, so a late listing or error can't land on this pane.
    reads.current++;
    setListing(null);
    setSelected(null);
    setError(null);
    if (on !== THIS_MAC) void browse();
  }, [on]);
  // The chosen computer went offline: stop reading from it. It was removed: back to This Mac.
  useEffect(() => {
    if (on === THIS_MAC) return;
    if (!computer) setOn(THIS_MAC);
    else if (!reachable) reads.current++;
  }, [on, computer, reachable]);
  // It came back after being away: the folder on screen is read again, since it may have changed (or the last read was cut off).
  const wasReachable = useRef(reachable);
  const folderOnScreen = useRef<string | undefined>(undefined);
  folderOnScreen.current = listing?.path;
  useEffect(() => {
    const returned = reachable && !wasReachable.current;
    wasReachable.current = reachable;
    if (returned && on !== THIS_MAC) void browse(folderOnScreen.current);
  }, [reachable]);

  async function chooseHere() {
    setError(null);
    try {
      const opened = await window.milagre.openProject();
      if (opened) onOpened(opened);
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    }
  }
  async function add() {
    if (!computer || !reachable || !selected) return;
    setBusy(true);
    setError(null);
    try {
      onOpened(await bridgeFor(computer.id).openProjectAt(selected.path));
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const crumbs = listing ? ["~", ...listing.path.slice(listing.home.length).split("/").filter(Boolean)] : [];
  const [now] = useState(() => Date.now());

  return (
    <Dialog data-add-project title="Add project" onClose={onClose} width={520}>
      <p className="mt-4 text-12 text-ink-3">On</p>
      <div className="mt-1.5 flex gap-1.5">
        {[
          { id: THIS_MAC, name: thisMac, line: "This Mac", tone: "online" as const, away: false },
          ...computers.map((item) => ({ id: item.id, name: item.name, line: routeLine(item, now), tone: computerTone(item), away: item.state !== "online" })),
        ].map((choice) => (
          <button
            key={choice.id}
            type="button"
            data-add-project-on={choice.id}
            aria-pressed={on === choice.id}
            disabled={choice.away}
            onClick={() => setOn(choice.id)}
            className={`flex h-11 min-w-0 flex-1 items-center gap-2 rounded-card px-3 text-left ring-1 transition-colors duration-fast disabled:opacity-40 ${on === choice.id ? "bg-accent-tint ring-accent" : "ring-line-strong enabled:hover:bg-hover"}`}
          >
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: DOT_COLOR[choice.tone] }} />
            <span className="min-w-0">
              <span className="block truncate text-13 font-medium">{choice.name}</span>
              <span className="block truncate text-11 text-ink-3">{choice.line}</span>
            </span>
          </button>
        ))}
      </div>
      {on === THIS_MAC ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-13 text-ink-2">Choose a folder on this Mac.</p>
          <Button variant="secondary" onClick={() => void chooseHere()}>
            Choose folder…
          </Button>
        </div>
      ) : (
        <>
          <p className="mt-4 text-12 text-ink-3">Folder on {computer?.name}</p>
          {!reachable && (
            <p data-add-project-away className="mt-1.5 text-13 text-ink-2">
              {computer?.name} is offline. Pick another computer or wait for it to come back.
            </p>
          )}
          <div data-folder-path className="mt-1.5 flex h-9 items-center gap-1 rounded-control bg-field px-2.5 text-12 text-ink-2 ring-1 ring-line-strong">
            {crumbs.map((crumb, index) =>
              index === crumbs.length - 1 && index > 0 ? (
                <b key={index} className="font-medium text-ink">{` ${crumb} /`}</b>
              ) : (
                <span key={index}>{`${index > 0 ? " " : ""}${crumb} /`}</span>
              ),
            )}
          </div>
          <ScrollArea className="mt-2 h-[250px] rounded-card ring-1 ring-line">
            {listing?.parent && (
              <button
                type="button"
                onClick={() => void browse(listing.parent!)}
                className="flex h-8 w-full items-center gap-2 border-b border-line px-3 text-left text-13 text-ink-2 transition-colors duration-fast hover:bg-hover focus-visible:-outline-offset-2"
              >
                ..
              </button>
            )}
            {listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                data-folder={entry.name}
                aria-pressed={selected?.path === entry.path}
                onClick={() => setSelected(entry)}
                onDoubleClick={() => void browse(entry.path)}
                className={`flex h-8 w-full items-center gap-2 border-b border-line px-3 text-left text-13 transition-colors duration-fast last:border-b-0 focus-visible:-outline-offset-2 ${selected?.path === entry.path ? "bg-hover-2 text-ink" : "text-ink-2 hover:bg-hover"}`}
              >
                <Icon icon={FolderOpenIcon} size={16} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {(entry.project || entry.git) && (
                  <span data-folder-tag className="shrink-0 text-11 text-ink-3">
                    {entry.project ? "Added" : `git · ${entry.branch ?? "detached"}`}
                  </span>
                )}
              </button>
            ))}
          </ScrollArea>
          {listing?.truncated && (
            <p data-add-project-truncated className="mt-1.5 text-12 text-ink-3">
              Showing the first 500 folders.
            </p>
          )}
        </>
      )}
      <InlineError className="mt-3">{error}</InlineError>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-12 text-ink-3">{computer ? `Opens on ${computer.name}. Its daemon owns the Project; this window drives it.` : ""}</span>
        <span className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {computer && (
            <Button disabled={!reachable || !selected || !(selected.git || selected.project) || busy} onClick={() => void add()}>
              {selected ? `${selected.project ? "Open" : "Add"} ${selected.name}` : "Add project"}
            </Button>
          )}
        </span>
      </div>
    </Dialog>
  );
}
