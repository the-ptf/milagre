/** Transfer whole binary files in bounded chunks on local, LAN and relay connections. */
export async function downloadAttachment(read, write, progress = () => {}) {
  let offset = 0;
  let version;
  let size;
  do {
    const chunk = await read(offset, version);
    if (!chunk || !Number.isSafeInteger(chunk.size) || chunk.size < 0 || typeof chunk.version !== "string" || typeof chunk.base64 !== "string")
      throw new Error("Could not download this file. Try again.");
    size ??= chunk.size;
    version ??= chunk.version;
    if (size !== chunk.size || version !== chunk.version) throw new Error("The file changed during download. Try again.");
    const bytes = Uint8Array.from(atob(chunk.base64), (character) => character.charCodeAt(0));
    if (offset + bytes.length > size || (!bytes.length && offset < size)) throw new Error("File download was interrupted. Try again.");
    await write(bytes);
    offset += bytes.length;
    progress(offset, size);
  } while (offset < size);
  return size;
}
