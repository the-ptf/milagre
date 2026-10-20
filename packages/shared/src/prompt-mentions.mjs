import { promptParts } from "./prompt-parts.mjs";

/**
 * The attached file an `@path` mention names: the file at that absolute path, else the file at `<root>/<path>`,
 * else the one attached file whose path ends with `/<path>`. A suffix shared by several files names none.
 */
export function mentionedFile(path, files, root) {
  if (!path) return undefined;
  const exact = files.find((file) => file === path) ?? files.find((file) => file === `${root.replace(/\/$/, "")}/${path}`);
  if (exact) return exact;
  const suffixed = files.filter((file) => file.endsWith(`/${path.replace(/^\//, "")}`));
  return suffixed.length === 1 ? suffixed[0] : undefined;
}

/** Whether `@path` in a sent prompt names one of the message's files, for `promptParts`. */
export function isMentionOfFile(files, root) {
  return (path) => mentionedFile(path, files, root) !== undefined;
}

/** The absolute files a prompt renders inline as chips; their attachment tiles are left out. */
export function mentionedFiles(prompt, files, root) {
  const found = new Set();
  if (!files.length) return found;
  for (const part of promptParts(prompt, { skills: [], files: isMentionOfFile(files, root) })) {
    if (part.kind !== "file") continue;
    const file = mentionedFile(part.path, files, root);
    if (file) found.add(file);
  }
  return found;
}
