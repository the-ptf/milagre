import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ScrollArea } from "./primitives/ScrollArea";
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
      className="fixed inset-0 m-auto max-h-[80vh] w-[600px] max-w-[calc(100vw-2rem)] rounded-2xl bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/30 backdrop:backdrop-blur-overlay"
    >
      <div className="flex max-h-[80vh] flex-col">
        <header className="flex items-center gap-4 border-b border-line p-5">
          <div className="flex-1">
            <h2 id="release-notes-title" className="text-[18px] font-medium">
              What's new
            </h2>
            <p className="mt-1 text-[13px] text-ink-2">Milagre v{version}</p>
          </div>
          <button
            type="button"
            aria-label="Close release notes"
            onClick={close}
            className="rounded-md p-2 text-ink-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink"
          >
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <ScrollArea className="p-5 text-[14px] leading-relaxed [overflow-wrap:anywhere]">
          {failed ? (
            <div role="alert">
              <p>Could not load release notes. Check your connection and try again.</p>
              <button
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
                className="mt-4 rounded-control border border-line-strong px-3 py-2 hover:bg-hover"
              >
                Try again
              </button>
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
