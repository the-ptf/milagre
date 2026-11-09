import { Fragment, useMemo, type ReactNode } from "react";
import { promptParts } from "@milagre/shared/prompt-parts";
import { useChatMentions } from "./ChatMentions";
import { ChatChip, ComputerChip, FileChip, ImageChip, SkillChip } from "./PromptChip";

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
  const mentions = useChatMentions();
  const parts = useMemo(
    // A sent `@computer:` token was a chip when it was written: it stays one even once that computer is gone.
    () => promptParts(text, { skills: [...skills.keys()], files, images, chats: (id) => mentions.chats.some((chat) => chat.id === id), computers: () => true }),
    [text, skills, files, images, mentions.chats],
  );
  // Each chip keeps the token it stands for (`@path`, `/skill`), so a passage quoted from it reads as it was typed.
  const token = (key: string | number, typed: string, chip: ReactNode) => (
    <span key={key} data-token={typed} className="contents">
      {chip}
    </span>
  );
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : part.kind === "chat" ? (
          token(
            `chat:${part.id}:${part.start}`,
            part.text,
            <ChatChip
              title={mentions.chats.find((chat) => chat.id === part.id)?.title ?? "Chat"}
              onOpen={
                mentions.chats.some((chat) => chat.id === part.id && chat.available) && mentions.onOpen
                  ? () => mentions.onOpen?.(`${mentions.project}#${part.id}`)
                  : undefined
              }
            />,
          )
        ) : (
          token(
            index,
            part.text,
            part.kind === "skill" ? (
              <SkillChip name={part.name} description={skills.get(part.name.toLowerCase())} />
            ) : part.kind === "file" ? (
              <FileChip path={part.path} onOpen={onOpenFile ? () => onOpenFile(part.path) : undefined} />
            ) : part.kind === "computer" ? (
              <ComputerChip name={part.name} />
            ) : (
              <ImageChip index={part.index} name={imageNames?.[part.index - 1]} onOpen={onOpenImage ? () => onOpenImage(part.index) : undefined} />
            ),
          )
        ),
      )}
    </span>
  );
}
