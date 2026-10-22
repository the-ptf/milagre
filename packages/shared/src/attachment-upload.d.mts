export type AttachmentUploadRequest = { projectPath: string; name: string; base64: string; transferId?: string; offset?: number; totalBytes?: number };
export type UploadedAttachment = { path: string; name?: string; id?: string };
export const ATTACHMENT_CHUNK_CHARS: number;
export function uploadAttachment<T extends UploadedAttachment>(
  send: (request: AttachmentUploadRequest) => Promise<T | null>,
  request: AttachmentUploadRequest,
  createId?: () => string,
): Promise<T>;
