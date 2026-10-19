import type { RoutineTrigger } from "./model.ts";

/** Comes first in a rendered prompt that has fenced text, once, whatever the number of blocks. */
export const UNTRUSTED_NOTE: string;

/** The placeholders a trigger fills, in the order the autocomplete lists them, each with an example of what it expands to. */
export function placeholdersFor(trigger: RoutineTrigger): Array<{ name: string; example: string }>;

/**
 * The prompt with its `{{placeholders}}` filled from `values`. A name `values` doesn't have stays as typed. A value goes in
 * as it is unless its name is in `untrusted` (placeholder name to a label for where the text came from): that text is data
 * from outside, so it is always fenced as `<untrusted-data source="label">`, whatever its length: as a block, or on the
 * sentence's line when it is one short line of up to 200 characters and not one of the free-text fields
 * (`issue.description`, `comment.body`, `body`, `request`), which are always blocks. Only identifiers stay out of
 * `untrusted`. When anything was fenced, `UNTRUSTED_NOTE` and a blank line come first.
 * Dynamic names (`body.a.b`, `headers.x`, `query.x`) are flat keys of both maps.
 */
export function renderRoutinePrompt(template: string, values: Record<string, string | undefined>, untrusted: Record<string, string>): string;

/**
 * The placeholder being typed at `caret`, or null when the caret isn't in an unclosed `{{`. `start` is where that `{{` is
 * (the first brace of a longer run), `query` the name typed after it (spaces right after the `{{` are allowed, as the
 * renderer allows them), `matches` the `names` that begin with it (case-insensitive), in the order given.
 */
export function placeholderQuery(text: string, caret: number, names: string[]): { start: number; query: string; matches: string[] } | null;

/**
 * Replaces the text from `start` (the `{{`) to `caret` with `{{name}}`; the caret goes after the `}}`. Text after the caret
 * goes too only when it is the rest of this placeholder: the name and braces of a closed one, or the rest of `name` typed
 * on both sides of the caret. Anything else after the caret stays.
 */
export function insertPlaceholder(text: string, start: number, caret: number, name: string): { text: string; caret: number };
