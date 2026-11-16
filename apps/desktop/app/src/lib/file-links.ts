import { titleSpans } from "./reply-parts.ts";

export function fileSpanIndex(title: string, file: string | undefined): number {
  if (!file || !/^(Read|Edited|Created|Wrote|Deleted) /.test(title)) return -1;
  return titleSpans(title).findIndex((span) => span.code);
}
