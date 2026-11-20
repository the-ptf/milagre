import { useState } from "react";
import type { DesignLibraryEntry, DesignLibraryPage } from "@milagre/shared/artifact";
import { bridgeForKey } from "../../lib/computer-bridge";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { InlineError } from "../primitives/InlineError";
import { LibraryPagePicker, useLibraryPageChoice } from "../design-library/LibraryPagePicker";

/** What goes to the library: one of the Chat's designs, or its HTML page (one `tab` of it). */
export type LibrarySource = { designId: string; title: string; tab?: string };

/** Asks which page of the Project library a design goes on, an existing one or a new name, and adds it there. */
export function AddToLibraryDialog({
  chatId,
  pages,
  source,
  onClose,
  onAdded,
}: {
  chatId: string;
  pages: DesignLibraryPage[];
  source: LibrarySource;
  onClose: () => void;
  onAdded: (entry: DesignLibraryEntry) => void;
}) {
  const choice = useLibraryPageChoice(pages);
  const { page } = choice;
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    if (!page || adding) return;
    setAdding(true);
    setError("");
    try {
      onAdded(await bridgeForKey(chatId).artifacts.addToLibrary({ chatId, designId: source.designId, page, ...(source.tab ? { tab: source.tab } : {}) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setAdding(false);
    }
  };
  return (
    <div
      role="presentation"
      className="contents"
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Dialog
        as="form"
        data-slot="add-to-library"
        title="Add to Project library"
        description={`Every Chat in this Project can open ${source.title}, and their agents can keep working on it. This Chat's copy stays as it is.`}
        onClose={adding ? undefined : onClose}
        onSubmit={() => void add()}
        width={400}
        actions={
          <>
            <Button variant="ghost" type="button" disabled={adding} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" data-slot="library-add" disabled={!page || adding}>
              {adding ? "Adding…" : "Add"}
            </Button>
          </>
        }
      >
        <LibraryPagePicker pages={pages} state={choice} disabled={adding} />
        <InlineError size={12} className="mt-3">
          {error}
        </InlineError>
      </Dialog>
    </div>
  );
}
