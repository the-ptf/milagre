import { titleSpans } from "./reply-parts.ts";

/** Which of a step title's spans (see titleSpans) is its file, or -1. Only a read or edit with a known file has one. */
export function fileSpanIndex(title: string, file: string | undefined): number {
  if (!file || !/^(Read|Edited|Created|Wrote|Deleted) /.test(title)) return -1;
  return titleSpans(title).findIndex((span) => span.code);
}
