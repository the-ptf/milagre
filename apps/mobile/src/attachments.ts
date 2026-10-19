import type { ImageAttachment } from "@milagre/shared/model";
import type { Client } from "./client";

export type Attachment = { id: string; name: string; uri: string; image?: ImageAttachment; base64?: string; path?: string };
const MAX_ATTACHMENTS = 4;
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
