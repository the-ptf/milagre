// Subchats: a Chat a Delegation inside one Project reached keeps the requester's session id as `parent`
// (AgentSession.parent, ChatHost.adoptSubchat). The Chat lists on desktop and phone nest it under its topmost ancestor
// that is still listed, and open it beside that Chat.

/** A listed Chat's parent, by key (`<project>#<id>`), or undefined for a top-level Chat. */
export type ParentOf = (key: string) => string | undefined;

/** `<project>#<parent>` for a session that has one: subchats always share their parent's Project. */
export function parentKey(key: string, parent: number | undefined): string | undefined {
  if (parent === undefined) return undefined;
  const hash = key.lastIndexOf("#");
  return hash < 0 ? undefined : `${key.slice(0, hash)}#${parent}`;
}

/**
 * The topmost ancestor of `key` that `listed` holds, or undefined when no ancestor is listed (an archived or hidden
 * parent leaves its subchats top-level). A broken chain that loops stops where it repeats.
 */
export function subchatRoot(key: string, parentOf: ParentOf, listed: (key: string) => boolean): string | undefined {
  let root: string | undefined;
  const seen = new Set([key]);
  for (let at = parentOf(key); at !== undefined && !seen.has(at); at = parentOf(at)) {
    seen.add(at);
    if (listed(at)) root = at;
  }
  return root;
}

export interface SubchatGroup<T> {
  row: T;
  /** The listed subchats under `row`, in the list's order; empty for a Chat without any. */
  children: T[];
}

/**
 * `rows` with each subchat moved under its topmost listed ancestor. A family sits where its first member was, so a
 * subchat's activity brings its parent up with it; children keep their own order.
 */
export function nestSubchats<T>(rows: readonly T[], keyOf: (row: T) => string, parentOf: ParentOf): SubchatGroup<T>[] {
  const listed = new Set(rows.map(keyOf));
  const byKey = new Map(rows.map((row) => [keyOf(row), row]));
  const groups = new Map<string, SubchatGroup<T>>();
  const order: SubchatGroup<T>[] = [];
  const groupOf = (key: string) => {
    let group = groups.get(key);
    if (!group) {
      group = { row: byKey.get(key)!, children: [] };
      groups.set(key, group);
      order.push(group);
    }
    return group;
  };
  for (const row of rows) {
    const key = keyOf(row);
    const root = subchatRoot(key, parentOf, (at) => listed.has(at));
    if (root === undefined) groupOf(key);
    else groupOf(root).children.push(row);
  }
  return order;
}

export type FamilySession = { id: number; parent?: number; archived?: boolean; done_at?: number };

/**
 * The family the Chat `key` belongs to in its Project's state: its topmost ancestor still listed (not archived), and that
 * ancestor's listed subchats, oldest first (Done ones left out). Null for a Chat with no family.
 */
export function chatFamily(sessions: Record<string, FamilySession> | undefined, key: string): { root: string; children: string[] } | null {
  if (!sessions) return null;
  const scope = key.slice(0, key.lastIndexOf("#"));
  const listed = (at: string) => {
    const session = sessions[at.slice(scope.length + 1)];
    return Boolean(session && !session.archived);
  };
  const parentOf = (at: string) => parentKey(at, sessions[at.slice(scope.length + 1)]?.parent);
  const root = subchatRoot(key, parentOf, listed) ?? key;
  const children = Object.values(sessions)
    .filter((session) => !session.archived && !session.done_at && session.parent !== undefined)
    .map((session) => `${scope}#${session.id}`)
    .filter((at) => at !== root && subchatRoot(at, parentOf, listed) === root);
  return children.length || root !== key ? { root, children } : null;
}
