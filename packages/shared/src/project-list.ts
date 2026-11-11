/** The letter on a Project's tile when it has no image: its name's first letter, "M" for none. */
export function projectInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "M";
}

/** A Project tile's corner radius by its size, on both apps: 16 → 4, 20–24 → 6, 32–40 → 10, larger → 20. Person
 * avatars are round instead. */
export function projectAvatarRadius(size: number): number {
  return size <= 16 ? 4 : size <= 24 ? 6 : size <= 40 ? 10 : 20;
}

/** A Project tile without an image, as palette keys: an ink square with an on-ink initial at weight 600. The Chats
 * home mark is the same tile with a bubble glyph. */
export const PROJECT_AVATAR = { fill: "ink", ink: "onInk" } as const;

/**
 * project:scan-children's answer: the repositories (and other folders) in a folder being added. A folder that holds
 * several repositories is added as each of them plus a Named Link that groups them. `chosen`: starts checked (every
 * repository).
 */
export type FolderScan = {
  folder: string;
  /** The folder is a Git repository itself: it opens as one Project. */
  git: boolean;
  children: { path: string; name: string; relative: string; git: boolean; chosen: boolean }[];
  /** Settings › Worktrees › Detect repositories in a folder: off, the folder opens as one Project. */
  detect: boolean;
};

/** One top-level entry of a list and the entries drawn under it, in the order they came. */
export type ListNode<T> = { item: T; children: T[] };

/**
 * A list one level deep: each entry whose `parentOf` names another entry in it goes under that one (the Tree layout puts
 * a Named Link's member Projects under the Link). An entry whose parent isn't listed stays at the top, in its place.
 */
export function nestUnder<T>(items: readonly T[], keyOf: (item: T) => string, parentOf: (item: T) => string | undefined): ListNode<T>[] {
  const keys = new Set(items.map(keyOf));
  const nested = (item: T) => {
    const parent = parentOf(item);
    return parent !== undefined && parent !== keyOf(item) && keys.has(parent);
  };
  const children = new Map<string, T[]>();
  for (const item of items) if (nested(item)) children.set(parentOf(item)!, [...(children.get(parentOf(item)!) ?? []), item]);
  return items.filter((item) => !nested(item)).map((item) => ({ item, children: children.get(keyOf(item)) ?? [] }));
}

/**
 * The Named Link each Project is drawn under in the Tree layout, by Project path: the first listed Link that has it as a
 * member, so a Project in several Links shows once.
 */
export function linkOwners(links: readonly { key: string; memberPaths: readonly string[] }[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const link of links) for (const member of link.memberPaths) if (member && !owners.has(member)) owners.set(member, link.key);
  return owners;
}

/** One Worktree of a Project in the Tree layout, with its Chats. `primary`: the main checkout. */
export type WorktreeGroup<R> = { path: string; name: string; primary: boolean; rows: R[] };

/**
 * A Project's Chats by Worktree, as the Tree layout draws them: the main checkout's first (`primary`), then every other
 * Worktree with Chats, the one with the newest Chat first. A Chat whose Worktree the state doesn't list (it went away)
 * gets a group of its own under its folder's name. A Project without Chats has none.
 */
export function worktreeGroups<R>({
  projectPath,
  worktrees,
  rows,
  pathOf,
  branchOf,
}: {
  projectPath: string;
  worktrees: readonly { path: string; name: string }[];
  /** In the sidebar's order, newest first. */
  rows: readonly R[];
  pathOf: (row: R) => string | undefined;
  branchOf: (row: R) => string | undefined;
}): WorktreeGroup<R>[] {
  const groups = new Map<string, WorktreeGroup<R>>();
  const primary = worktrees.find((worktree) => worktree.path === projectPath);
  groups.set(projectPath, { path: projectPath, name: primary?.name ?? projectPath.split("/").findLast(Boolean) ?? projectPath, primary: true, rows: [] });
  const named = new Map(worktrees.map((worktree) => [worktree.path, worktree.name]));
  for (const row of rows) {
    const path = pathOf(row) ?? projectPath;
    let group = groups.get(path);
    if (!group) {
      group = { path, name: named.get(path) ?? branchOf(row) ?? path.split("/").findLast(Boolean) ?? path, primary: false, rows: [] };
      groups.set(path, group);
    }
    group.rows.push(row);
  }
  return rows.length ? [...groups.values()] : [];
}

/** Whether a Worktree's group gets a heading in the Tree layout: one shared by several Chats, never the main checkout. */
export const worktreeHeading = (group: WorktreeGroup<unknown>) => !group.primary && group.rows.length > 1;
