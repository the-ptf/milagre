import { useState } from "react";
import type { DesignLibraryPage } from "@milagre/shared/artifact";
import { FIELD_LABEL, Input } from "../primitives/Field";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioGroup";
import { SectionLabel } from "../primitives/SectionLabel";

const NEW_PAGE = "+new";

/**
 * The choice of a Project library page: one of `pages` or a new name typed in. `page` is the chosen page's name, empty
 * until there is one.
 */
export function useLibraryPageChoice(pages: DesignLibraryPage[], initial?: string) {
  const [choice, setChoice] = useState(initial ?? pages[0]?.id ?? NEW_PAGE);
  const [name, setName] = useState("");
  const page = choice === NEW_PAGE ? name.trim() : (pages.find((item) => item.id === choice)?.name ?? "");
  return { choice, setChoice, name, setName, page };
}

export function LibraryPagePicker({
  pages,
  state,
  disabled,
  current,
}: {
  pages: DesignLibraryPage[];
  state: ReturnType<typeof useLibraryPageChoice>;
  disabled: boolean;
  /** The page the design is on now, marked in the list. */
  current?: string;
}) {
  const field = (
    <Input
      data-slot="library-page-name"
      aria-label="New page name"
      placeholder="iPhone, Watch, Kit…"
      maxLength={60}
      autoFocus={!pages.length}
      value={state.name}
      disabled={disabled}
      onFocus={() => state.setChoice(NEW_PAGE)}
      onChange={(event) => state.setName(event.target.value)}
    />
  );
  if (!pages.length)
    return (
      <label className="mt-4 flex flex-col gap-1.5">
        <span className={FIELD_LABEL}>Page</span>
        {field}
      </label>
    );
  return (
    <fieldset disabled={disabled} className="mt-4">
      <SectionLabel as="legend" className="mb-2">
        Page
      </SectionLabel>
      <RadioGroup value={state.choice} onValueChange={state.setChoice}>
        <div className="space-y-1">
          {pages.map((item) => (
            <label key={item.id} className="flex h-8 cursor-pointer items-center gap-3 rounded-control px-2 transition-colors hover:bg-hover">
              <RadioGroupItem value={item.id} aria-label={item.name} />
              <span className="min-w-0 flex-1 truncate text-13">{item.name}</span>
              {item.id === current && <span className="text-12 text-ink-3">Now</span>}
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
  );
}
