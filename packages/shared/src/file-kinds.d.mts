export type FileKind = { badge: string | null; icon: "react" | "image" | "folder" | "file" | null; color: string };
export function fileKind(path: string): FileKind;
