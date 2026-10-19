import { promptParts } from "@milagre/shared/prompt-parts";

/** The attached file an `@path` mention names: the file at `<root>/<path>`, or any file whose path ends with `/<path>`. */
export function mentionedFile(path: string, files: readonly string[], root: string): string | undefined {
  if (!path) return undefined;
  const base = root.replace(/\/$/, "");
  return files.find((file) => file === `${base}/${path}` || file.endsWith(`/${path}`));
}

/** Whether `@path` in a sent prompt names one of the message's files, for `promptParts`. */
export function isMentionOfFile(files: readonly string[], root: string) {
  return (path: string) => mentionedFile(path, files, root) !== undefined;
}

/** The absolute files a prompt renders inline as chips; their attachment tiles are left out. */
export function mentionedFiles(prompt: string, files: readonly string[], root: string): Set<string> {
  const found = new Set<string>();
  if (!files.length) return found;
  for (const part of promptParts(prompt, { skills: [], files: isMentionOfFile(files, root) })) {
    if (part.kind !== "file") continue;
    const file = mentionedFile(part.path, files, root);
    if (file) found.add(file);
  }
  return found;
}
