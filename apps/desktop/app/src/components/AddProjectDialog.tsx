import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { FolderOpenIcon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { DirListing } from "../electron";
import type { OpenProject } from "../model";
import { bridgeFor } from "../lib/computer-bridge";
import { DOT_COLOR, computerTone, routeLine, useComputers } from "../lib/computers";
import { ScrollArea } from "./primitives/ScrollArea";
import { ThisComputer, thisComputer } from "../lib/shortcut-hints";

const THIS_MAC = "this-mac";

/**
 * Add project with other computers (design add-project-remote v1): choose the computer (offline ones disabled), then a
 * folder on it. This Mac keeps its folder dialog; another computer's home folder is browsed through fs:list-dirs and the
 * checkout opens there, whose daemon owns it. Mounted only while open.
 */
export function AddProjectDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (project: OpenProject) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { thisMac, computers } = useComputers();
  const [on, setOn] = useState<string>(THIS_MAC);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [selected, setSelected] = useState<DirListing["entries"][number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reads = useRef(0);
  const computer = computers.find((item) => item.id === on);
  const reachable = computer?.state === "online";

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

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

  return createPortal(
    <dialog
      ref={dialog}
      data-add-project
      aria-labelledby="add-project-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A press on the scrim (the dialog itself, outside its padded content) closes it.
        if (event.target === dialog.current) onClose();
      }}
      className="m-auto w-[520px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[14px] bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <div className="p-5">
        <h2 id="add-project-title" className="text-[16px] font-semibold">
          Add project
        </h2>
        <p className="mt-3.5 text-[12px] text-ink-3">On</p>
        <div className="mt-1.5 flex gap-1.5">
          {[
            { id: THIS_MAC, name: thisMac, line: ThisComputer, tone: "online" as const, away: false },
            ...computers.map((item) => ({ id: item.id, name: item.name, line: routeLine(item, now), tone: computerTone(item), away: item.state !== "online" })),
          ].map((choice) => (
            <button
              key={choice.id}
              type="button"
              data-add-project-on={choice.id}
              aria-pressed={on === choice.id}
              disabled={choice.away}
              onClick={() => setOn(choice.id)}
              className={`flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-3 text-left ring-1 disabled:opacity-45 ${on === choice.id ? "bg-accent/15 ring-[1.5px] ring-accent" : "ring-line-strong hover:bg-hover"}`}
            >
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: DOT_COLOR[choice.tone] }} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{choice.name}</span>
                <span className="block truncate text-[11.5px] text-ink-3">{choice.line}</span>
              </span>
            </button>
          ))}
        </div>
        {on === THIS_MAC ? (
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-[13px] text-ink-2">Choose a folder on {thisComputer}.</p>
            <button type="button" onClick={() => void chooseHere()} className="rounded-control px-3 py-2 text-[13px] ring-1 ring-line-strong hover:bg-hover-2">
              Choose folder…
            </button>
          </div>
        ) : (
          <>
            <p className="mt-4 text-[12px] text-ink-3">Folder on {computer?.name}</p>
            {!reachable && (
              <p data-add-project-away className="mt-1.5 text-[13px] text-ink-2">
                {computer?.name} is offline. Pick another computer or wait for it to come back.
              </p>
            )}
            <div
              data-folder-path
              className="mt-1.5 flex h-[34px] items-center gap-1 rounded-[9px] bg-field px-2.5 text-[12.5px] text-ink-2 ring-1 ring-line-strong"
            >
              {crumbs.map((crumb, index) =>
                index === crumbs.length - 1 && index > 0 ? (
                  <b key={index} className="font-medium text-ink">{` ${crumb} /`}</b>
                ) : (
                  <span key={index}>{`${index > 0 ? " " : ""}${crumb} /`}</span>
                ),
              )}
            </div>
            <ScrollArea className="mt-2 h-[250px] rounded-[10px] ring-1 ring-line">
              {listing?.parent && (
                <button
                  type="button"
                  onClick={() => void browse(listing.parent!)}
                  className="flex h-[34px] w-full items-center gap-2.5 border-b border-line px-3 text-left text-[13px] text-ink-2 hover:bg-hover"
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
                  className={`flex h-[34px] w-full items-center gap-2.5 border-b border-line px-3 text-left text-[13px] last:border-b-0 ${selected?.path === entry.path ? "bg-hover-2 text-ink" : "text-ink-2 hover:bg-hover"}`}
                >
                  <HugeiconsIcon icon={FolderOpenIcon} size={15} strokeWidth={1.8} color="currentColor" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {(entry.project || entry.git) && (
                    <span data-folder-tag className="shrink-0 text-[11px] text-ink-3">
                      {entry.project ? "Added" : `git · ${entry.branch ?? "detached"}`}
                    </span>
                  )}
                </button>
              ))}
            </ScrollArea>
            {listing?.truncated && (
              <p data-add-project-truncated className="mt-1.5 text-[12px] text-ink-3">
                Showing the first 500 folders.
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-red-ink">
            {error}
          </p>
        )}
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-3">{computer ? `Opens on ${computer.name}. Its daemon owns the Project; this window drives it.` : ""}</span>
          <span className="flex shrink-0 gap-2">
            <button type="button" onClick={onClose} className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2">
              Cancel
            </button>
            {computer && (
              <button
                type="button"
                disabled={!reachable || !selected || !(selected.git || selected.project) || busy}
                onClick={() => void add()}
                className="rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-surface disabled:opacity-40"
              >
                {selected ? `${selected.project ? "Open" : "Add"} ${selected.name}` : "Add project"}
              </button>
            )}
          </span>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
