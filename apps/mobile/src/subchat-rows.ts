// Subchats in the Chat list (subchats.ts): each subchat's row moves under its parent's, indented, and the parent's row
// counts them and folds them away, as desktop's sidebar does (subchat-rows.ts there).
import { nestSubchats } from "@milagre/shared/subchats";

type Listed = { kind: string; key: string };
type ChatLike = Listed & { kind: "chat"; chat: { id: number; parent?: number; pinned?: boolean } };

/** What nesting adds to a Chat row: indented under its parent (`root`, the family's top Chat), or a parent with `count` subchats. */
export type SubchatMarks = { subchat?: boolean; root?: number; family?: { count: number; folded: boolean } };

const isChat = (row: Listed): row is ChatLike => row.kind === "chat";

/** `<computer>|<project>#<parent>` for a row keyed `<computer>|<project>#<id>`. */
const parentKeyOf = (row: ChatLike) => (row.chat.parent === undefined ? undefined : `${row.key.slice(0, row.key.lastIndexOf("#"))}#${row.chat.parent}`);

/**
 * The list with each run of Chat rows (a Project's, or the one list's) nested: pinned rows keep their place, the rest put
 * each subchat under its topmost listed ancestor, and a family in `folded` (by the parent row's key) shows its parent alone.
 */
export function nestChatRows<R extends Listed>(rows: readonly R[], folded: { has(key: string): boolean }): (R & SubchatMarks)[] {
  if (!rows.some((row) => isChat(row) && row.chat.parent !== undefined)) return rows as R[];
  const result: (R & SubchatMarks)[] = [];
  let run: (R & ChatLike)[] = [];
  const flush = () => {
    if (!run.length) return;
    const free = run.filter((row) => !row.chat.pinned);
    const byKey = new Map(free.map((row) => [row.key, row]));
    for (const row of run) if (row.chat.pinned) result.push(row);
    for (const { row, children } of nestSubchats(
      free,
      (row) => row.key,
      (key) => {
        const row = byKey.get(key);
        return row && parentKeyOf(row);
      },
    )) {
      if (!children.length) {
        result.push(row);
        continue;
      }
      const isFolded = folded.has(row.key);
      result.push({ ...row, family: { count: children.length, folded: isFolded } });
      if (!isFolded) for (const child of children) result.push({ ...child, subchat: true, root: row.chat.id });
    }
    run = [];
  };
  for (const row of rows) {
    if (isChat(row)) {
      run.push(row as R & ChatLike);
      continue;
    }
    flush();
    result.push(row);
  }
  flush();
  return result;
}
