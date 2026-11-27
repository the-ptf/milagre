import { useEffect, useState } from "react";
import { MESSAGE_SEARCH_COPY, readMessageFilters, type MessageFilters } from "@milagre/shared/message-search-view";
import { Checkbox } from "./primitives/Checkbox";
import { Chip } from "./primitives/Chip";
import { radioKeys } from "./primitives/Segmented";
import type { Command } from "../lib/commands";
import type { MessageSearchSource } from "../lib/message-commands";

const FILTERS_KEY = "milagre.message-search";

type Found = { key: string; commands: Command[]; failed: string[]; error?: string };

function loadFilters(): MessageFilters {
  try {
    return readMessageFilters(JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null"));
  } catch {
    return readMessageFilters(null);
  }
}

/** The palette's message mode: its filters (kept between openings), and the host's answer for the query on screen. */
export function useMessageMode(source: MessageSearchSource | undefined, initial: "commands" | "messages", query: string) {
  const [mode, setMode] = useState<"commands" | "messages">(source && initial === "messages" ? "messages" : "commands");
  const [filters, setFilterState] = useState(loadFilters);
  const [found, setFound] = useState<Found | null>(null);
  const typed = query.trim();
  const active = mode === "messages" && Boolean(source) && typed.length >= 2;
  const key = `${filters.scope}|${filters.archived}|${typed}`;
  useEffect(() => {
    if (!active || !source) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      source.search(typed, filters).then(
        (result) => !cancelled && setFound({ key, ...result }),
        (error: unknown) => !cancelled && setFound({ key, commands: [], failed: [], error: error instanceof Error ? error.message : String(error) }),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key names the query and filters; source is the same search.
  }, [active, key]);
  const current = active && found?.key === key ? found : null;
  return {
    mode,
    setMode,
    filters,
    setFilters: (next: MessageFilters) => {
      setFilterState(next);
      localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
    },
    tooShort: mode === "messages" && typed.length < 2,
    searching: active && !current,
    results: current?.commands ?? [],
    failed: current?.failed ?? [],
    error: current?.error,
  };
}

export function MessageFilterBar({
  hereLabel,
  filters,
  onChange,
}: {
  hereLabel: string;
  filters: MessageFilters;
  onChange: (filters: MessageFilters) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-2">
      <div role="radiogroup" aria-label="Where to search" onKeyDown={radioKeys()} className="flex gap-1.5">
        {(
          [
            ["here", hereLabel],
            ["all", MESSAGE_SEARCH_COPY.all],
          ] as const
        ).map(([scope, label]) => (
          <Chip
            key={scope}
            variant="filter"
            checked={filters.scope === scope}
            tabIndex={filters.scope === scope ? 0 : -1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange({ ...filters, scope })}
          >
            {label}
          </Chip>
        ))}
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-12 text-ink-2">
        <Checkbox checked={filters.archived} onCheckedChange={(archived) => onChange({ ...filters, archived })} />
        {MESSAGE_SEARCH_COPY.archived}
      </label>
    </div>
  );
}
