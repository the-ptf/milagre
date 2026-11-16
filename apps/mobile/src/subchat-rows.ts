import { nestSubchats } from "@milagre/shared/subchats";

type Listed = { kind: string; key: string };
type ChatLike = Listed & { kind: "chat"; chat: { id: number; parent?: number; pinned?: boolean }; mark?: string };

const asks = (row: ChatLike) => row.mark === "question" || row.mark === "waiting";

export type SubchatMarks = { subchat?: boolean; depth?: number; family?: { count: number; folded: boolean; asking?: boolean } };

const isChat = (row: Listed): row is ChatLike => row.kind === "chat";

const parentKeyOf = (row: ChatLike) => (row.chat.parent === undefined ? undefined : `${row.key.slice(0, row.key.lastIndexOf("#"))}#${row.chat.parent}`);

export function nestChatRows<R extends Listed>(rows: readonly R[], folded: { has(key: string): boolean }): (R & SubchatMarks)[] {
  if (!rows.some((row) => isChat(row) && row.chat.parent !== undefined)) return rows as R[];
  const result: (R & SubchatMarks)[] = [];
  let run: (R & ChatLike)[] = [];
  const flush = () => {
    if (!run.length) return;
    const free = run.filter((row) => !row.chat.pinned);
    const byKey = new Map(free.map((row) => [row.key, row]));
    for (const row of run) if (row.chat.pinned) result.push(row);
    for (const { row, children, depths } of nestSubchats(
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
      result.push({ ...row, family: { count: children.length, folded: isFolded, asking: children.some(asks) } });
      if (!isFolded) children.forEach((child, index) => result.push({ ...child, subchat: true, depth: depths[index] ?? 1 }));
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
