import { uploadAttachment, type AttachmentUploadRequest } from "@milagre/shared/attachment-upload";
import { retryKind, retrySend } from "@milagre/shared/send-retry";
import type { ImageAttachment } from "../model";
import { bridgeForKey } from "./computer-bridge";

export async function uploadFile(owner: string, name: string, base64: string, current: () => boolean = () => true) {
  return uploadAttachment(
    async (request: AttachmentUploadRequest) => {
      if (!current()) throw new Error("Attachment upload was cancelled.");
      const result = await retrySend(() => bridgeForKey(owner).uploadAttachment(request), { retryable: (error) => current() && retryKind(error) !== null });
      if (result.error) throw new Error(result.error.message);
      return result.file ?? null;
    },
    { projectPath: owner, name, base64 },
  );
}

/** Upload each image separately so the send carries paths, regardless of total attachment bytes. */
export async function prepareImageUploads(owner: string, images: ImageAttachment[]) {
  const prepared: ImageAttachment[] = [];
  for (const image of images) {
    if (!image.dataUrl) {
      prepared.push(image);
      continue;
    }
    const file = await uploadFile(owner, image.name, image.dataUrl.slice(image.dataUrl.indexOf(",") + 1));
    prepared.push({ id: image.id, name: image.name, path: file.path });
  }
  return prepared;
}
