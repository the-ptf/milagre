import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { ScrollArea } from "./primitives/ScrollArea";
import { Button, IconButton } from "./primitives/Button";
import { Markdown } from "./markdown/Markdown";

export function UpdateReleaseNotes({ version, onClose }: { version: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let live = true;
    setNotes(null);
    setFailed(false);
    window.milagre.getUpdateReleaseNotes(version).then(
      (value) => {
        if (live) setNotes(value);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [version, attempt]);
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="release-notes-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      className="fixed inset-0 m-auto max-h-[80vh] w-[600px] max-w-[calc(100vw-2rem)] rounded-window bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim backdrop:backdrop-blur-overlay"
      style={{ animation: "pop-in var(--duration-base) var(--ease-enter) both" }}
    >
      <div className="flex max-h-[80vh] flex-col">
        <header className="flex items-center gap-4 border-b border-line p-5">
          <div className="flex-1">
            <h2 id="release-notes-title" className="text-17 font-semibold">
              What's new
            </h2>
            <p className="mt-1 text-13 text-ink-2">Milagre v{version}</p>
          </div>
          <IconButton label="Close release notes" icon={Cancel01Icon} iconSize={18} size={32} onClick={close} />
        </header>
        <ScrollArea className="p-5 text-13 leading-relaxed [overflow-wrap:anywhere]">
          {failed ? (
            <div role="alert">
              <p>Could not load release notes. Check your connection and try again.</p>
              <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)} className="mt-4">
                Try again
              </Button>
            </div>
          ) : notes === null ? (
            <p role="status" className="text-ink-2">
              Loading release notes…
            </p>
          ) : notes ? (
            <Markdown text={notes} />
          ) : (
            <p className="text-ink-2">No release notes were published for this version.</p>
          )}
        </ScrollArea>
      </div>
    </dialog>,
    document.body,
  );
}
