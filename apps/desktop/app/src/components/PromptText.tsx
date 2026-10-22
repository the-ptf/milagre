import { Fragment, useMemo } from "react";
import { promptParts } from "@milagre/shared/prompt-parts";
import { FileChip, ImageChip, SkillChip } from "./PromptChip";

/**
 * A prompt as typed, with its skills, file mentions and inline images as chips.
 * `skills` maps lowercase skill names to their descriptions; `files` says which `@path` mentions are real files;
 * `images` is the number of attached images in the message.
 */
export function PromptText({
  text,
  skills,
  files,
  images = 0,
  imageNames,
  onOpenFile,
  onOpenImage,
}: {
  text: string;
  skills: ReadonlyMap<string, string>;
  files: (path: string) => boolean;
  images?: number;
  imageNames?: readonly (string | undefined)[];
  onOpenFile?: (path: string) => void;
  onOpenImage?: (index: number) => void;
}) {
  const parts = useMemo(() => promptParts(text, { skills: [...skills.keys()], files, images }), [text, skills, files, images]);
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, index) =>
        part.kind === "skill" ? (
          <SkillChip key={index} name={part.name} description={skills.get(part.name.toLowerCase())} />
        ) : part.kind === "file" ? (
          <FileChip key={index} path={part.path} onOpen={onOpenFile ? () => onOpenFile(part.path) : undefined} />
        ) : part.kind === "image" ? (
          <ImageChip key={index} index={part.index} name={imageNames?.[part.index - 1]} onOpen={onOpenImage ? () => onOpenImage(part.index) : undefined} />
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </span>
  );
}
