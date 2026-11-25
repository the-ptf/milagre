import { artifactDownload, type ArtifactPageMessage, type HtmlArtifact } from "@milagre/shared/artifact";
import { downloadAttachment } from "@milagre/shared/attachment-download";
import { bridgeForKey } from "../../lib/computer-bridge";
import { showToast } from "../../lib/toast";

declare global {
  interface Window {
    showSaveFilePicker(options: { suggestedName: string }): Promise<FileSystemFileHandle>;
  }
}

export async function saveArtifactDownload(
  chatId: string,
  page: HtmlArtifact,
  preview: string | undefined,
  message: Extract<ArtifactPageMessage, { t: "download" }>,
) {
  const file = artifactDownload(page.assets, message, (asset) => preview && `${preview}/assets/${asset.name}`);
  if (!file || !navigator.userActivation.isActive) return;
  try {
    const destination = await window.showSaveFilePicker({ suggestedName: file.name });
    const writer = await destination.createWritable();
    try {
      const api = bridgeForKey(chatId).artifacts;
      await downloadAttachment(
        async (offset) => {
          const chunk = await api.asset({ chatId, name: file.asset.name, offset });
          if (chunk.hash !== file.asset.hash || chunk.size !== file.asset.size || chunk.offset !== offset)
            throw new Error("This file changed. Open the page again.");
          return { base64: chunk.base64, size: chunk.size, version: chunk.hash };
        },
        (bytes) => writer.write(bytes),
      );
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    showToast("File saved.");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    showToast(error instanceof Error ? error.message : "Could not save this file.");
  }
}
