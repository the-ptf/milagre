import { uploadAttachment, type AttachmentUploadRequest } from "@milagre/shared/attachment-upload";
import { retryKind, retrySend } from "@milagre/shared/send-retry";
import type { ImageAttachment } from "../model";
import { bridgeForKey } from "./computer-bridge";

/** Files picked while offline stay in the composer until either the local queue or the computer saves their bytes. */
export async function prepareLocalFileUploads(owner: string, files: string[], images: ImageAttachment[], localFiles: Map<string, File>) {
  const result: string[] = [];
  for (const path of files) {
    if (!path.startsWith("/.milagre-offline-attachments/")) {
      result.push(path);
      continue;
    }
    if (images.some((image) => image.path === path && image.dataUrl)) continue;
    const file = localFiles.get(path);
    if (!file) throw new Error("Attachment data is missing. Attach the file again.");
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1]!));
      reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}. Attach it again.`)));
      reader.readAsDataURL(file);
    });
    result.push((await uploadFile(owner, file.name, base64)).path);
  }
  return result;
}

export async function uploadFile(
  owner: string,
  name: string,
  base64: string,
  current: () => boolean = () => true,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
) {
  return uploadAttachment(
    async (request: AttachmentUploadRequest) => {
      if (!current()) throw new Error("Attachment upload was cancelled.");
      const result = await retrySend(() => bridgeForKey(owner).uploadAttachment(request), { retryable: (error) => current() && retryKind(error) !== null });
      if (result.error) throw new Error(result.error.message);
      return result.file ?? null;
    },
    { projectPath: owner, name, base64 },
    undefined,
    onProgress,
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
    // The upload's path is a temporary copy. The file the user chose stays the image's source, so the sent message, which also
    // lists that file, shows the image once.
    prepared.push({
      id: image.id,
      name: image.name,
      path: file.path,
      ...(image.path && !image.path.startsWith("/.milagre-offline-attachments/") ? { sourcePath: image.path } : {}),
    });
  }
  return prepared;
}
