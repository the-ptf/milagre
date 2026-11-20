import { useState } from "react";
import type { DesignLibraryEntry, DesignLibraryPage } from "@milagre/shared/artifact";
import { bridgeForKey } from "../../lib/computer-bridge";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { FIELD_LABEL, Input } from "../primitives/Field";
import { InlineError } from "../primitives/InlineError";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioGroup";
import { SectionLabel } from "../primitives/SectionLabel";

/** What goes to the library: one of the Chat's designs, or its HTML page (one `tab` of it). */
export type LibrarySource = { designId: string; title: string; tab?: string };

const NEW_PAGE = "+new";

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
  const [choice, setChoice] = useState(pages[0]?.id ?? NEW_PAGE);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const page = choice === NEW_PAGE ? name.trim() : (pages.find((item) => item.id === choice)?.name ?? "");
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
  const field = (
    <Input
      data-slot="library-page-name"
      aria-label="New page name"
      placeholder="iPhone, Watch, Kit…"
      maxLength={60}
      autoFocus={!pages.length}
      value={name}
      disabled={adding}
      onFocus={() => setChoice(NEW_PAGE)}
      onChange={(event) => setName(event.target.value)}
    />
  );
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
        {pages.length ? (
          <fieldset disabled={adding} className="mt-4">
            <SectionLabel as="legend" className="mb-2">
              Page
            </SectionLabel>
            <RadioGroup value={choice} onValueChange={setChoice}>
              <div className="space-y-1">
                {pages.map((item) => (
                  <label key={item.id} className="flex h-8 cursor-pointer items-center gap-3 rounded-control px-2 transition-colors hover:bg-hover">
                    <RadioGroupItem value={item.id} aria-label={item.name} />
                    <span className="min-w-0 flex-1 truncate text-13">{item.name}</span>
                    <span className="text-12 text-ink-3 tabular-nums">{item.designs.length}</span>
                  </label>
                ))}
                <label className="flex cursor-pointer items-center gap-3 rounded-control px-2 py-1">
                  <RadioGroupItem value={NEW_PAGE} aria-label="New page" />
                  {field}
                </label>
              </div>
            </RadioGroup>
          </fieldset>
        ) : (
          <label className="mt-4 flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Page</span>
            {field}
          </label>
        )}
        <InlineError size={12} className="mt-3">
          {error}
        </InlineError>
      </Dialog>
    </div>
  );
}
