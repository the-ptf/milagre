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
 * project:scan-children's answer: what a folder holds that could be its Sub-projects. `chosen` is what starts checked:
 * its current Sub-projects when it is a Parent Project already, else every repository.
 */
export type SubprojectScan = {
  folder: string;
  /** The folder is a Git repository itself. */
  git: boolean;
  children: { path: string; name: string; relative: string; git: boolean; chosen: boolean }[];
  /** Settings › Worktrees › Detect Sub-projects. */
  detect: boolean;
};

/** One top-level Project of a list and the Sub-projects listed under it, in the order they came. */
export type ProjectNode<T> = { item: T; children: T[] };

/**
 * A Projects list as a tree one level deep: each Sub-project goes under its Parent Project wherever the list put it. A
 * Sub-project whose parent isn't in the list stays a Project of its own.
 */
export function projectTree<T>(items: readonly T[], keyOf: (item: T) => string, parentOf: (item: T) => string | undefined): ProjectNode<T>[] {
  const nodes = new Map<string, ProjectNode<T>>();
  for (const item of items) if (!parentOf(item)) nodes.set(keyOf(item), { item, children: [] });
  for (const item of items) {
    const parent = parentOf(item);
    const node = parent === undefined ? undefined : nodes.get(parent);
    if (node) node.children.push(item);
    else if (parent !== undefined) nodes.set(keyOf(item), { item, children: [] });
  }
  return items.flatMap((item) => {
    const node = nodes.get(keyOf(item));
    return node?.item === item ? [node] : [];
  });
}

/** One Worktree of a Sub-project in the sidebar, with its Chats. `primary`: the main checkout. */
export type WorktreeGroup<R> = { path: string; name: string; primary: boolean; rows: R[] };

/**
 * A Sub-project's Chats by Worktree, the way the sidebar nests them: the main checkout's first (`primary`: they sit right
 * under the Sub-project, with no heading), then every other Worktree with Chats, the one with the newest Chat first. A Chat whose Worktree the state doesn't list (it went
 * away) gets a group of its own under its folder's name. A Sub-project without Chats has none: its heading says it all.
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

/** The no-choice row of a Project's account picker: its Parent Project's account for a Sub-project, else the computer default. */
export function accountFallbackLabel(inheritedFrom: string | undefined): string {
  return inheritedFrom ? `Use ${inheritedFrom.split("/").findLast(Boolean) ?? inheritedFrom}'s account` : "Use computer default";
}
