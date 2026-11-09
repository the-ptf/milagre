export interface AttachmentChunk {
  base64: string;
  size: number;
  version: string;
}
export function downloadAttachment(
  read: (offset: number, version?: string) => Promise<AttachmentChunk>,
  write: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>,
  progress?: (received: number, total: number) => void,
): Promise<number>;
