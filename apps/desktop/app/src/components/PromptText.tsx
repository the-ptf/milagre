import { Fragment, useMemo } from "react";
import { promptParts } from "@milagre/shared/prompt-parts";
import { FileChip, SkillChip } from "./PromptChip";

/**
 * A prompt as typed, with its skills and file mentions as chips.
 * `skills` maps lowercase skill names to their descriptions; `files` says which `@path` mentions are real files.
 */
export function PromptText({
  text,
  skills,
  files,
  onOpenFile,
}: {
  text: string;
  skills: ReadonlyMap<string, string>;
  files: (path: string) => boolean;
  onOpenFile?: (path: string) => void;
}) {
  const parts = useMemo(() => promptParts(text, { skills: [...skills.keys()], files }), [text, skills, files]);
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, index) =>
        part.kind === "skill" ? (
          <SkillChip key={index} name={part.name} description={skills.get(part.name.toLowerCase())} />
        ) : part.kind === "file" ? (
          <FileChip key={index} path={part.path} onOpen={onOpenFile ? () => onOpenFile(part.path) : undefined} />
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </span>
  );
}
