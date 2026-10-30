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
