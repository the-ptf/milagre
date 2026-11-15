/** The letter on a Project's tile when it has no image: its name's first letter, "M" for none. */
export function projectInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "M";
}

export function projectAvatarRadius(size: number): number {
  return size <= 16 ? 4 : size <= 24 ? 6 : size <= 40 ? 10 : 20;
}

export const PROJECT_AVATAR = { fill: "ink", ink: "onInk" } as const;

/**
 * project:scan-children's answer: the repositories (and other folders) in a folder being added. `chosen`: starts
 * checked.
 */
export type FolderScan = {
  folder: string;
  git: boolean;
  children: { path: string; name: string; relative: string; git: boolean; chosen: boolean }[];
  detect: boolean;
};

export type ListNode<T> = { item: T; children: T[] };

/**
 * A list one level deep: an entry whose `parentOf` names another entry goes under it; an entry whose parent isn't
 * listed stays at the top.
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

/** The Named Link each Project is drawn under, by Project path: the first listed Link that has it as a member. */
export function linkOwners(links: readonly { key: string; memberPaths: readonly string[] }[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const link of links) for (const member of link.memberPaths) if (member && !owners.has(member)) owners.set(member, link.key);
  return owners;
}

export type WorktreeGroup<R> = { path: string; name: string; primary: boolean; rows: R[] };

/**
 * A Project's Chats by Worktree: the main checkout first (`primary`), then other Worktrees with Chats, newest Chat
 * first. A Chat whose Worktree isn't listed gets its own group under its folder's name.
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

export const worktreeHeading = (group: WorktreeGroup<unknown>) => !group.primary && group.rows.length > 1;
