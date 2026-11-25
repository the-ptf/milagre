import { designFeedbackMessage, newCommentId, type DesignComment } from "@milagre/shared/artifact";
import type { ArtifactRef } from "@milagre/shared/model";
import type { Attachment } from "./attachments";

const IMAGE_ONLY = "See the attached image.";

type WrittenNote = DesignComment & { key: string; photos?: Attachment[] };

function numberedComments(notes: WrittenNote[]) {
  const images: Attachment[] = [];
  const comments = notes.map(({ key: _key, photos, ...note }): DesignComment => {
    const numbers = (photos ?? []).map((photo) => images.push(photo));
    return { ...note, text: note.text.trim() || IMAGE_ONLY, id: newCommentId(), ...(numbers.length ? { images: numbers } : {}) };
  });
  return { comments, images };
}

export function designFeedback(notes: WrittenNote[], choice: ArtifactRef | null) {
  const { comments, images } = numberedComments(notes);
  return { comments, message: { kind: "designs" as const, text: designFeedbackMessage({ choice, comments }), images } };
}
