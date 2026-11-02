import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import * as Clipboard from "expo-clipboard";
import { MAX_FILE_BYTES, MAX_PHOTO_BYTES, type Attachment } from "./attachments";

export type PastedImage = { uri: string; width: number; height: number; error?: string };

export function discardPastedImage(image: PastedImage) {
  if (image.uri) {
    try {
      new File(image.uri).delete();
    } catch {
      /* The cache may already have been cleaned. */
    }
  }
}

export async function preparePastedImage(image: PastedImage): Promise<Attachment> {
  try {
    if (image.error) throw new Error(image.error);
    return await preparePhoto({ ...image, fileName: "Pasted image.png" }, 0);
  } finally {
    discardPastedImage(image);
  }
}

export async function pickAttachments(kind: "photos" | "camera" | "files" | "paste"): Promise<Attachment[]> {
  if (kind === "paste") {
    const image = await Clipboard.getImageAsync({ format: "png" });
    if (!image) throw new Error("Copy an image first, then allow paste access if asked. You can also choose it from Photo Library.");
    return [await preparePhoto({ uri: image.data, width: image.size.width, height: image.size.height, fileName: "Pasted image.png" }, 0)];
  }
  if (kind === "photos" || kind === "camera") {
    if (kind === "camera" && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error("Allow camera access in Settings to take a photo.");
    const result =
      kind === "camera"
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"] })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images", "videos"],
            allowsMultipleSelection: true,
            selectionLimit: 0,
            // iOS exports 720p H.264 MP4. Android keeps the picked video's format.
            videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
          });
    if (result.canceled) return [];
    return Promise.all(result.assets.map((asset, index) => (asset.type === "video" ? prepareVideo(asset, index) : preparePhoto(asset, index))));
  }
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
  if (result.canceled) return [];
  return Promise.all(
    result.assets.map(async (asset, index) => {
      const file = new File(asset.uri);
      if (file.size > MAX_FILE_BYTES) throw new Error(`${asset.name} is larger than 50 MiB.`);
      return { id: `${Date.now()}-${index}`, name: asset.name, uri: asset.uri, base64: await file.base64() };
    }),
  );
}

/** A picked video goes as a file: the agent gets its path on the computer. */
async function prepareVideo(asset: ImagePicker.ImagePickerAsset, index: number): Promise<Attachment> {
  const file = new File(asset.uri);
  const name = videoName(asset.fileName, index, asset.uri);
  if (file.size > MAX_FILE_BYTES) {
    discardPicked(file);
    throw new Error(`${name} is larger than 50 MiB. Trim it in Photos, then attach it again.`);
  }
  return { id: `${Date.now()}-${index}`, name, uri: asset.uri, base64: await file.base64(), video: true };
}

/** Keep the picked name but use the exported file's extension; Android does not transcode every format to MP4. */
export function videoName(fileName: string | null | undefined, index: number, uri = "") {
  const extension = /\.([a-z\d]+)$/i.exec(uri.split(/[?#]/)[0] ?? "")?.[1] ?? /\.([a-z\d]+)$/i.exec(fileName ?? "")?.[1] ?? "mp4";
  return `${(fileName || `Video ${index + 1}`).replace(/\.[^.]+$/, "")}.${extension}`;
}

function discardPicked(file: File) {
  try {
    file.delete();
  } catch {
    /* The cache may already have been cleaned. */
  }
}

async function preparePhoto(asset: { uri: string; width: number; height: number; fileName?: string | null }, index: number): Promise<Attachment> {
  const context = ImageManipulator.manipulate(asset.uri);
  let rendered: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
  try {
    context.resize(asset.width > asset.height ? { width: Math.min(asset.width, 1024) } : { height: Math.min(asset.height, 1024) });
    rendered = await context.renderAsync();
    let photo = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.7, base64: true });
    if (((photo.base64?.length || 0) * 3) / 4 > MAX_PHOTO_BYTES) photo = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.35, base64: true });
    if (!photo.base64 || (photo.base64.length * 3) / 4 > MAX_PHOTO_BYTES)
      throw new Error("This photo is too detailed to send here. Use Files to attach the original.");
    const id = `${Date.now()}-${index}`,
      name = (asset.fileName || `Photo ${index + 1}`).replace(/\.[^.]+$/, "") + ".jpg";
    return { id, name, uri: photo.uri, image: { id, name, dataUrl: `data:image/jpeg;base64,${photo.base64}` } };
  } finally {
    rendered?.release();
    context.release();
  }
}
