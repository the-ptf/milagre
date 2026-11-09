// Subchats: a Chat a Delegation inside one Project reached keeps the requester's session id as `parent`
// (AgentSession.parent, ChatHost.adoptSubchat). The Chat lists on desktop and phone nest it under its topmost ancestor
// that is still listed. It opens alone, as any Chat does, with a bookmark back to the Chat above it (chatBookmark).

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
  /** The listed subchats under `row`, each right after the Chat above it; empty for a Chat without any. */
  children: T[];
  /** How deep each of `children` sits, by index: 1 directly under `row`, MAX_SUBCHAT_DEPTH at most. */
  depths: number[];
}

/** The sidebars indent a family this deep at most: anything further sits level with its parent. */
export const MAX_SUBCHAT_DEPTH = 2;

/** `children` of `root` in tree order, each after the listed Chat above it; siblings keep their order. */
function treeOrder<T>(
  root: string,
  children: readonly T[],
  keyOf: (row: T) => string,
  parentOf: ParentOf,
  listed: (key: string) => boolean,
): { children: T[]; depths: number[] } {
  const under = new Map<string, T[]>();
  for (const child of children) {
    const seen = new Set([keyOf(child)]);
    let above = parentOf(keyOf(child));
    while (above !== undefined && !listed(above) && !seen.has(above)) {
      seen.add(above);
      above = parentOf(above);
    }
    const parent = above === undefined || seen.has(above) ? root : above;
    under.set(parent, [...(under.get(parent) ?? []), child]);
  }
  const ordered: T[] = [];
  const depths: number[] = [];
  const placed = new Set<string>();
  const walk = (key: string, depth: number) => {
    for (const child of under.get(key) ?? []) {
      const at = keyOf(child);
      if (placed.has(at)) continue;
      placed.add(at);
      ordered.push(child);
      depths.push(Math.min(depth, MAX_SUBCHAT_DEPTH));
      walk(at, depth + 1);
    }
  };
  walk(root, 1);
  // A broken chain that loops never reaches `root`: its Chats stay in the family, directly under it.
  for (const child of children) {
    if (placed.has(keyOf(child))) continue;
    ordered.push(child);
    depths.push(1);
  }
  return { children: ordered, depths };
}

/**
 * `rows` with each subchat moved under its topmost listed ancestor. A family sits where its first member was, so a
 * subchat's activity brings its parent up with it; a subchat sits right after the Chat above it, siblings in their order.
 */
export function nestSubchats<T>(rows: readonly T[], keyOf: (row: T) => string, parentOf: ParentOf): SubchatGroup<T>[] {
  const listed = new Set(rows.map(keyOf));
  const byKey = new Map(rows.map((row) => [keyOf(row), row]));
  const groups = new Map<string, SubchatGroup<T>>();
  const order: SubchatGroup<T>[] = [];
  const groupOf = (key: string) => {
    let group = groups.get(key);
    if (!group) {
      group = { row: byKey.get(key)!, children: [], depths: [] };
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
  for (const group of order) {
    if (group.children.length < 2) {
      group.depths = group.children.map(() => 1);
      continue;
    }
    Object.assign(
      group,
      treeOrder(keyOf(group.row), group.children, keyOf, parentOf, (at) => listed.has(at)),
    );
  }
  return order;
}

export type FamilySession = { id: number; parent?: number; archived?: boolean; done_at?: number };

/**
 * The family the Chat `key` belongs to in its Project's state: its topmost ancestor still listed (not archived), and that
 * ancestor's listed subchats, oldest first. Done ones are left out, except `key` itself, which is always in its own family.
 * Null for a Chat with no family.
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
    .filter((session) => !session.archived && session.parent !== undefined)
    .map((session) => ({ session, at: `${scope}#${session.id}` }))
    .filter(({ session, at }) => (!session.done_at || at === key) && at !== root && subchatRoot(at, parentOf, listed) === root)
    .map(({ at }) => at);
  return children.length || root !== key ? { root, children } : null;
}

/**
 * What the bookmark over the open Chat `key` points at: its nearest ancestor still listed, and the listed ones above that
 * (the top Chat first), which collapse into its "…". An archived direct parent is skipped, so the bookmark and the sidebar
 * agree. Null for a top-level Chat, or one with no listed ancestor left.
 */
export function chatBookmark(sessions: Record<string, FamilySession> | undefined, key: string): { parent: string; above: string[] } | null {
  if (!sessions) return null;
  const scope = key.slice(0, key.lastIndexOf("#"));
  const sessionOf = (at: string) => sessions[at.slice(scope.length + 1)];
  const chain: string[] = [];
  const seen = new Set([key]);
  for (let at = parentKey(key, sessionOf(key)?.parent); at !== undefined && !seen.has(at); at = parentKey(at, sessionOf(at)?.parent)) {
    seen.add(at);
    const session = sessionOf(at);
    if (session && !session.archived) chain.push(at);
  }
  const [parent, ...above] = chain;
  return parent === undefined ? null : { parent, above: above.toReversed() };
}
