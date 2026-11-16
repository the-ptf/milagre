import type { ImageSourcePropType } from "react-native";

export type ThumbRect = { x: number; y: number; width: number; height: number };
export type MediaValue = ImageSourcePropType | Promise<ImageSourcePropType>;
export type ViewerImage = { source: MediaValue; name: string; caption?: string; from?: ThumbRect };
let current: { images: ViewerImage[]; index: number } = { images: [], index: 0 };
export function showImages(images: ViewerImage[], index: number) {
  current = { images, index };
}
export function viewerImages() {
  return current;
}
