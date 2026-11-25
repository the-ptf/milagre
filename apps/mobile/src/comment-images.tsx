import { useState } from "react";
import { Image, View } from "react-native";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { discardPastedImage, preparePastedImage, type PastedImage } from "./attachment-picker";
import type { Attachment } from "./attachments";
import { IconButton } from "./ui";
import { useTheme } from "./theme";
import { radius, space } from "./design-tokens";

export const MAX_COMMENT_IMAGES = 4;

export function CommentImageStrip({ photos, onRemove }: { photos: Attachment[]; onRemove: (id: string) => void }) {
  const { colors } = useTheme();
  if (!photos.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, paddingTop: space.xs }}>
      {photos.map((photo, index) => (
        <View key={photo.id} style={{ width: 52, height: 52 }}>
          <Image
            source={{ uri: photo.uri }}
            accessibilityLabel={`Image ${index + 1}`}
            style={{ width: 52, height: 52, borderRadius: radius.control, backgroundColor: colors.field }}
          />
          <View style={{ position: "absolute", top: -10, right: -10 }}>
            <IconButton label={`Remove image ${index + 1}`} icon={Cancel01Icon} filled size={32} onPress={() => onRemove(photo.id)} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Images pasted into a comment's field: up to MAX_COMMENT_IMAGES, each prepared like a composer photo. */
export function useCommentPaste(photos: Attachment[], onPhotos?: (photos: Attachment[]) => void) {
  const [error, setError] = useState("");
  const onPaste = onPhotos
    ? async (image: PastedImage) => {
        if (photos.length >= MAX_COMMENT_IMAGES) {
          discardPastedImage(image);
          return setError(`A comment takes up to ${MAX_COMMENT_IMAGES} images.`);
        }
        try {
          const photo = await preparePastedImage(image);
          setError("");
          onPhotos([...photos, photo].slice(0, MAX_COMMENT_IMAGES));
        } catch (failure) {
          setError((failure as Error).message);
        }
      }
    : undefined;
  return { onPaste, error };
}
