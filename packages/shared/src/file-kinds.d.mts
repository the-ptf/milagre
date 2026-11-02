export type FileKind = { badge: string | null; icon: "react" | "image" | "folder" | "file" | null; color: string };
export function fileKind(path: string): FileKind;
/** Images' identity color, the same in every theme: an image file's icon and a pasted image's chip. */
export const IMAGE_COLOR: string;
