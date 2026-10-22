import type { ImageAttachment } from "@milagre/shared/model";
import { formatImageMention, promptParts } from "@milagre/shared/prompt-parts";
import type { Client } from "./client";

export type Attachment = { id: string; name: string; uri: string; image?: ImageAttachment; base64?: string; path?: string };
const MAX_ATTACHMENTS = 4;
export const MAX_PHOTO_BYTES = 160 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Receipts follow the draft object, never a URI or attachment id that could now carry different bytes.
const uploads = new WeakMap<Attachment, { client: Client; projectPath: string; name: string; base64: string; id: string }>();
export function appendAttachments(current: Attachment[], added: Attachment[]) {
  if (current.length + added.length > MAX_ATTACHMENTS) throw new Error(ATTACHMENT_LIMIT_MESSAGE);
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
    if (item.image) images.push(item.image);
    else if (item.path) files.push(item.path);
    else {
      const saved = uploads.get(item);
      const matches = saved?.client === client && saved.projectPath === projectPath && saved.name === item.name && saved.base64 === item.base64;
      const reused = matches ? await retry(() => client.reuseUpload(projectPath, saved.id)) : null;
      const uploaded = reused ?? (await retry(() => client.upload(projectPath, item.name, item.base64!)));
      if (uploaded.id) uploads.set(item, { client, projectPath, name: item.name, base64: item.base64!, id: uploaded.id });
      files.push(uploaded.path);
    }
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
export const ATTACHMENT_LIMIT_MESSAGE = "Attach up to 4 photos or files per message.";
/** The error line once the attachments or the draft changed: the limit error goes when there is room again or the draft is cleared. */
export function settleLimitError(error: string, count: number, draft: string) {
  return error === ATTACHMENT_LIMIT_MESSAGE && (count < MAX_ATTACHMENTS || !draft.trim()) ? "" : error;
}
/** The attachments after a file is mentioned: unchanged when already attached, an error at the limit or for a path outside the project. */
export function addMention(current: Attachment[], root: string, path: string): { next: Attachment[]; error?: string } {
  let item: Attachment;
  try {
    item = mentionAttachment(root, path);
  } catch (failure) {
    return { next: current, error: (failure as Error).message };
  }
  if (current.some((other) => other.path === item.path)) return { next: current };
  if (current.length >= MAX_ATTACHMENTS) return { next: current, error: ATTACHMENT_LIMIT_MESSAGE };
  return { next: [...current, item] };
}
/**
 * The files the message's `@mentions` name (`isFile` says which are real project files) that are not attached yet, as
 * attachments. `dropped` is set when the attachment limit left one out.
 */
export function mentionAttachments(body: string, root: string, attached: Attachment[], isFile: (path: string) => boolean) {
  let next = attached;
  let dropped = false;
  for (const part of promptParts(body, { skills: [], files: isFile })) {
    if (part.kind !== "file") continue;
    const result = addMention(next, root, part.path);
    if (result.error === ATTACHMENT_LIMIT_MESSAGE) dropped = true;
    next = result.next;
  }
  return { added: next.slice(attached.length), dropped };
}
