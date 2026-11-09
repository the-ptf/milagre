import { useEffect, useState } from "react";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { InlineError } from "./primitives/InlineError";
import { Markdown } from "./markdown/Markdown";

export function UpdateReleaseNotes({ version, onClose }: { version: string; onClose: () => void }) {
  const [notes, setNotes] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
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
  return (
    <Dialog title="What's new" description={`Milagre v${version}`} onClose={onClose} closeLabel="Close release notes" width={600}>
      {/* Release notes are prose: 13 on a 20 line, as multi-paragraph text may be. */}
      <div className="mt-3 text-13 leading-5 [overflow-wrap:anywhere]">
        {failed ? (
          <InlineError
            variant="card"
            action={
              <Button variant="secondary" size={28} onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </Button>
            }
          >
            Could not load release notes. Check your connection and try again.
          </InlineError>
        ) : notes === null ? (
          <p role="status" className="text-ink-2">
            Loading release notes…
          </p>
        ) : notes ? (
          <Markdown text={notes} />
        ) : (
          <p className="text-ink-2">No release notes were published for this version.</p>
        )}
      </div>
    </Dialog>
  );
}
