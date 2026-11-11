import { useEffect, useRef, useState } from "react";
import { FolderOpenIcon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { DirListing } from "../electron";
import type { OpenProject } from "../model";
import { bridgeFor } from "../lib/computer-bridge";
import { DOT_COLOR, computerTone, routeLine, useComputers } from "../lib/computers";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { FIELD_LABEL, Input } from "./primitives/Field";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { ScrollArea } from "./primitives/ScrollArea";
import { useOpenFolder } from "./ImportFolderDialog";
import { ThisComputer, isWindows, thisComputer } from "../lib/shortcut-hints";

const THIS_MAC = "this-mac";
// Where a clone goes when no folder is chosen (onboarding-projects.cjs: <home>/Code).
const CODE_FOLDER = isWindows ? "~\\Code" : "~/Code";
type Mode = "open" | "clone";
const MODES: { id: Mode; name: string; line: string }[] = [
  { id: "open", name: "Open a folder", line: "A folder that is already there" },
  { id: "clone", name: "Clone a repository", line: "From a GitHub or Git address" },
];

/**
 * Add Project with other computers (design add-project-remote v1): choose the computer (offline ones disabled), then a
 * folder on it, or a repository to clone into one. This Mac keeps its folder dialog; another computer's home folder is browsed through fs:list-dirs and the
 * checkout opens there, whose daemon owns it. Mounted only while open.
 */
export function AddProjectDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (project: OpenProject) => void }) {
  const { thisMac, computers } = useComputers();
  const [on, setOn] = useState<string>(THIS_MAC);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [selected, setSelected] = useState<DirListing["entries"][number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>("open");
  const [url, setUrl] = useState("");
  // This Mac's clone folder, from its own dialog; null is ~/Code. Another computer's is the folder on screen.
  const [parent, setParent] = useState<string | null>(null);
  // A folder chosen on This Mac with repositories inside: the step that adds them takes the dialog's place.
  const folder = useOpenFolder(onOpened, onClose);
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
      const chosen = await bridgeFor(null).chooseFolder("Open project");
      if (chosen) await folder.open(chosen);
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    }
  }
  async function chooseParent() {
    setError(null);
    try {
      const chosen = await window.milagre.chooseFolder();
      if (chosen) setParent(chosen);
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    }
  }
  // Another computer clones into the folder picked in its list, else the one on screen.
  const cloneInto = computer ? (selected?.path ?? listing?.path) : (parent ?? undefined);
  async function clone() {
    if (computer && (!reachable || !cloneInto)) return;
    setBusy(true);
    setError(null);
    try {
      onOpened(await bridgeFor(computer?.id).cloneProject(url.trim(), cloneInto));
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setBusy(false);
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

  if (folder.dialog) return folder.dialog;

  return (
    <Dialog data-add-project title="Add Project" onClose={onClose} width={520}>
      {computers.length > 0 && (
        <>
          <p className={`mt-4 ${FIELD_LABEL}`}>On</p>
          <div className="mt-1 flex gap-1.5">
            {[
              { id: THIS_MAC, name: thisMac, line: ThisComputer, tone: "online" as const, away: false },
              ...computers.map((item) => ({
                id: item.id,
                name: item.name,
                line: routeLine(item, now),
                tone: computerTone(item),
                away: item.state !== "online",
              })),
            ].map((choice) => (
              <button
                key={choice.id}
                type="button"
                data-add-project-on={choice.id}
                aria-pressed={on === choice.id}
                disabled={choice.away}
                onClick={() => setOn(choice.id)}
                className={`flex h-11 min-w-0 flex-1 items-center gap-2 rounded-card px-3 text-left ring-1 transition-colors duration-fast disabled:opacity-40 ${on === choice.id ? "bg-hover-2 ring-ink" : "ring-line-strong enabled:hover:bg-hover"}`}
              >
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: DOT_COLOR[choice.tone] }} />
                <span className="min-w-0">
                  <span className="block truncate text-13 font-medium">{choice.name}</span>
                  <span className="block truncate text-11 text-ink-3">{choice.line}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      <p className={`mt-4 ${FIELD_LABEL}`}>Add</p>
      <div className="mt-1 flex gap-1.5">
        {MODES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            data-add-project-mode={choice.id}
            aria-pressed={mode === choice.id}
            onClick={() => setMode(choice.id)}
            className={`flex h-11 min-w-0 flex-1 items-center rounded-card px-3 text-left ring-1 transition-colors duration-fast ${mode === choice.id ? "bg-hover-2 ring-ink" : "ring-line-strong hover:bg-hover"}`}
          >
            <span className="min-w-0">
              <span className="block truncate text-13 font-medium">{choice.name}</span>
              <span className="block truncate text-11 text-ink-3">{choice.line}</span>
            </span>
          </button>
        ))}
      </div>
      {mode === "clone" && (
        <>
          <label className={`mt-4 block ${FIELD_LABEL}`} htmlFor="add-project-url">
            Repository address
          </label>
          <Input
            id="add-project-url"
            data-add-project-url
            autoFocus
            className="mt-1"
            placeholder="https://github.com/owner/repository"
            value={url}
            disabled={busy}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && url.trim() && !busy && (on === THIS_MAC || (reachable && cloneInto))) void clone();
            }}
          />
        </>
      )}
      {on === THIS_MAC ? (
        mode === "clone" ? (
          <>
            <p className={`mt-4 ${FIELD_LABEL}`}>Clone into</p>
            <div className="mt-1 flex items-center gap-2">
              <span
                data-clone-folder
                className="flex h-9 min-w-0 flex-1 items-center rounded-control bg-field px-2.5 text-13 text-ink-2 ring-1 ring-line-strong"
              >
                <span className="truncate">{parent ?? CODE_FOLDER}</span>
              </span>
              <Button variant="secondary" disabled={busy} onClick={() => void chooseParent()}>
                Choose folder…
              </Button>
            </div>
          </>
        ) : (
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-13 text-ink-2">Choose a folder on {thisComputer}.</p>
            <Button variant="secondary" onClick={() => void chooseHere()}>
              Choose folder…
            </Button>
          </div>
        )
      ) : (
        <>
          <p className={`mt-4 ${FIELD_LABEL}`}>{mode === "clone" ? `Clone into a folder on ${computer?.name}` : `Folder on ${computer?.name}`}</p>
          {!reachable && (
            <p data-add-project-away className="mt-1 text-13 text-ink-2">
              {computer?.name} is offline. Pick another computer or wait for it to come back.
            </p>
          )}
          <div data-folder-path className="mt-1 flex h-9 items-center gap-1 rounded-control bg-field px-2.5 text-12 text-ink-2 ring-1 ring-line-strong">
            {crumbs.map((crumb, index) =>
              index === crumbs.length - 1 && index > 0 ? (
                <b key={index} className="font-medium text-ink">{` ${crumb} /`}</b>
              ) : (
                <span key={index}>{`${index > 0 ? " " : ""}${crumb} /`}</span>
              ),
            )}
          </div>
          <ScrollArea className="mt-2 h-64 rounded-card ring-1 ring-line">
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
            <p data-add-project-truncated className="mt-1 text-12 text-ink-3">
              Showing the first 500 folders.
            </p>
          )}
        </>
      )}
      <InlineError className="mt-3">{error}</InlineError>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-12 text-ink-3">
          {computer ? `${mode === "clone" ? "Clones" : "Opens"} on ${computer.name}. Its daemon owns the Project; this window drives it.` : ""}
        </span>
        <span className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {mode === "clone" ? (
            <Button disabled={!url.trim() || busy || (Boolean(computer) && (!reachable || !cloneInto))} onClick={() => void clone()}>
              {busy ? "Cloning…" : "Clone"}
            </Button>
          ) : (
            computer && (
              <Button disabled={!reachable || !selected || !(selected.git || selected.project) || busy} onClick={() => void add()}>
                {selected ? `${selected.project ? "Open" : "Add"} ${selected.name}` : "Add Project"}
              </Button>
            )
          )}
        </span>
      </div>
    </Dialog>
  );
}
