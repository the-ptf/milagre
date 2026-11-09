import { Directory, File, FileMode } from "expo-file-system";
import { downloadAttachment, type AttachmentChunk } from "@milagre/shared/attachment-download";

/** The folder picker grants access on both iOS and Android; no new native module is needed. */
export async function saveAttachment({
  name,
  uri,
  read,
  progress,
}: {
  name: string;
  uri?: string;
  read: (offset: number, version?: string) => Promise<AttachmentChunk>;
  progress: (received: number, total: number) => void;
}) {
  let directory: Directory;
  try {
    directory = await Directory.pickDirectoryAsync();
  } catch (error) {
    if (error instanceof Error && /(?:pick|document).*cancel/i.test(error.message)) return false;
    throw error;
  }
  const filename = name.split(/[\\/]/).pop();
  if (!filename || filename === "." || filename === "..") throw new Error("Choose a file with a name.");
  // Creation refuses an existing file on iOS; Android's document provider picks a unique name.
  const destination = directory.createFile(filename, filename.toLowerCase().endsWith(".zip") ? "application/zip" : "application/octet-stream");
  try {
    if (uri) {
      await new File(uri).copy(destination, { overwrite: true });
    } else {
      const handle = destination.open(FileMode.WriteOnly);
      try {
        await downloadAttachment(read, (bytes) => handle.writeBytes(bytes), progress);
      } finally {
        handle.close();
      }
    }
    return true;
  } catch (error) {
    try {
      destination.delete();
    } catch {
      /* Preserve the transfer error if the selected folder became unavailable. */
    }
    throw error;
  }
}
