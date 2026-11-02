import type { OutboxAttachment } from "@milagre/shared/outbox";
import type { ImageAttachment } from "@milagre/shared/model";
import { formatImageMention, promptParts } from "@milagre/shared/prompt-parts";
import type { Client } from "./client";

/** `video` marks a video from Photos, sent as a file; the composer shows it as one. */
export type Attachment = { id: string; name: string; uri: string; image?: ImageAttachment; base64?: string; path?: string; video?: boolean };
import { MAX_ATTACHMENT_BYTES } from "@milagre/shared/limits";
export const MAX_PHOTO_BYTES = MAX_ATTACHMENT_BYTES;
export const MAX_FILE_BYTES = MAX_ATTACHMENT_BYTES;
// Receipts follow the draft object, never a URI or attachment id that could now carry different bytes.
const uploads = new WeakMap<Attachment, { client: Client; projectPath: string; name: string; base64: string; id: string }>();
export function appendAttachments(current: Attachment[], added: Attachment[]) {
  return [...current, ...added];
}
/** Appends `[Image #N]` mention(s) for newly attached photos/images to `draft`. */
export function appendImageMentions(draft: string, existingImages: number, addedImages: number): string {
  if (addedImages <= 0) return draft;
  const mentions = Array.from({ length: addedImages }, (_, index) => formatImageMention(existingImages + index + 1)).join(" ");
  const lead = draft.length > 0 && !/\s$/.test(draft) ? " " : "";
  return `${draft}${lead}${mentions} `;
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
    if (item.path && !item.image) {
      files.push(item.path);
      continue;
    }
    const base64 = item.image?.dataUrl?.split(",")[1] ?? item.base64;
    if (!base64) throw new Error("Attachment data is missing. Attach the file again.");
    const saved = uploads.get(item);
    const matches = saved?.client === client && saved.projectPath === projectPath && saved.name === item.name && saved.base64 === base64;
    const reused = matches ? await retry(() => client.reuseUpload(projectPath, saved.id)) : null;
    const uploaded = reused ?? (await retry(() => client.upload(projectPath, item.name, base64)));
    if (uploaded.id) uploads.set(item, { client, projectPath, name: item.name, base64, id: uploaded.id });
    if (item.image) images.push({ id: item.image.id, name: item.image.name, path: uploaded.path });
    else files.push(uploaded.path);
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
/** The attachments after a file is mentioned; duplicates stay attached once. */
export function addMention(current: Attachment[], root: string, path: string): { next: Attachment[]; error?: string } {
  let item: Attachment;
  try {
    item = mentionAttachment(root, path);
  } catch (failure) {
    return { next: current, error: (failure as Error).message };
  }
  if (current.some((other) => other.path === item.path)) return { next: current };
  return { next: [...current, item] };
}
/**
 * The files the message's `@mentions` name (`isFile` says which are real project files) that are not attached yet, as
 * attachments.
 */
export function mentionAttachments(body: string, root: string, attached: Attachment[], isFile: (path: string) => boolean) {
  let next = attached;
  for (const part of promptParts(body, { skills: [], files: isFile })) {
    if (part.kind !== "file") continue;
    const result = addMention(next, root, part.path);
    next = result.next;
  }
  return { added: next.slice(attached.length) };
}

export function outboxAttachments(items: Attachment[]): OutboxAttachment[] {
  return items.map((item) => {
    const base64 = item.image?.dataUrl?.split(",")[1] ?? item.base64;
    if (base64 === undefined && !item.path && !item.image?.path) throw new Error(`Attachment data is missing for ${item.name}. Attach it again.`);
    return {
      name: item.name,
      ...(item.image ? { imageId: item.image.id } : {}),
      ...(base64 !== undefined ? { base64 } : { path: item.path ?? item.image?.path }),
    };
  });
}
