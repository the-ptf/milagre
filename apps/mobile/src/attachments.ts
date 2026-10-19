import type { ImageAttachment } from "@milagre/shared/model";
import { promptParts } from "@milagre/shared/prompt-parts";
import type { Client } from "./client";

export type Attachment = { id: string; name: string; uri: string; image?: ImageAttachment; base64?: string; path?: string };
export const MAX_ATTACHMENTS = 4;
export const MAX_PHOTO_BYTES = 160 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export function appendAttachments(current: Attachment[], added: Attachment[]) {
  if (current.length + added.length > MAX_ATTACHMENTS) throw new Error("Attach up to 4 photos or files per message.");
  return [...current, ...added];
}
/** Uploads the files a message carries. `retry` runs each upload, so a busy Mac retries one file, not the ones already sent. */
export async function prepareAttachments(
  client: Client,
  projectPath: string,
  attachments: Attachment[],
  retry: <T>(upload: () => Promise<T>) => Promise<T> = (upload) => upload(),
) {
  const files: string[] = [];
  const images: ImageAttachment[] = [];
  for (const item of attachments) {
    if (item.image) images.push(item.image);
    else files.push(item.path || (await retry(() => client.upload(projectPath, item.name, item.base64!))).path);
  }
  return { files, images };
}
export function attachmentPrompt(body: string, files: string[]) {
  return files.length ? `${body || "Please review the attached files."}\n\nAttached files:\n${files.join("\n")}` : body || "Describe the attached images.";
}

/** A project file mentioned with `@`, as an attachment the Mac already has: its absolute path, no upload. Refuses paths that leave the root. */
export function mentionAttachment(root: string, path: string): Attachment {
  if (!root.startsWith("/") || !path || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "."))
    throw new Error("Mention a file inside the project.");
  const absolute = `${root.replace(/\/$/, "")}/${path}`;
  return { id: `mention:${absolute}`, name: path.split("/").pop()!, uri: absolute, path: absolute };
}
/** The files `@mentions` in a message name that are not attached yet, as attachments, up to the attachment limit. Mentions that leave the root are left alone. */
export function mentionAttachments(body: string, root: string, attached: Attachment[]): Attachment[] {
  const known = new Set(attached.map((item) => item.path).filter(Boolean));
  const added: Attachment[] = [];
  for (const part of promptParts(body, { skills: [], files: () => true })) {
    if (part.kind !== "file" || attached.length + added.length >= MAX_ATTACHMENTS) continue;
    let item: Attachment;
    try {
      item = mentionAttachment(root, part.path);
    } catch {
      continue;
    }
    if (known.has(item.path) || added.some((other) => other.path === item.path)) continue;
    added.push(item);
  }
  return added;
}
