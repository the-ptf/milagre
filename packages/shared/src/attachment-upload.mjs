import { MAX_ATTACHMENT_BYTES } from "./limits.mjs";
// A chunk fits the phone's HTTP body and every daemon/relay carrier, including JSON metadata.
export const ATTACHMENT_CHUNK_CHARS = 512 * 1024;
// onProgress(sentBytes, totalBytes) follows each acknowledged chunk, so a slow carrier can show how far a file got.
export async function uploadAttachment(send, request, createId = () => globalThis.crypto.randomUUID(), onProgress) {
  const { base64 } = request;
  const totalBytes = (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error("Each attachment must be 50 MiB or smaller.");
  if (base64.length <= ATTACHMENT_CHUNK_CHARS) {
    const file = await send(request);
    if (!file) throw new Error("Attachment upload did not finish. Try again.");
    onProgress?.(totalBytes, totalBytes);
    return file;
  }
  const transferId = createId();
  let result;
  onProgress?.(0, totalBytes);
  for (let start = 0; start < base64.length; start += ATTACHMENT_CHUNK_CHARS) {
    result = await send({ ...request, base64: base64.slice(start, start + ATTACHMENT_CHUNK_CHARS), transferId, offset: (start / 4) * 3, totalBytes });
    onProgress?.(Math.min(totalBytes, ((start + ATTACHMENT_CHUNK_CHARS) / 4) * 3), totalBytes);
  }
  if (!result) throw new Error("Attachment upload did not finish. Try again.");
  return result;
}
