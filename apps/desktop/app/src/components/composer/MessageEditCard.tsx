import { useState } from "react";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { editingText } from "@milagre/shared/message-edit";
import type { MessageEditFlow } from "@milagre/shared/use-message-edit";
import { FileRow } from "../checkpoints/UndoPanel";
import { Button } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { ShortcutKeys } from "../primitives/ShortcutKeys";

const fileCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

/** Above the composer while a sent message is edited: what goes with it, and the files its removed turns changed. */
export function MessageEditCard({
  flow,
  running,
  sending,
  error,
  onCancel,
  onOpenFile,
}: {
  flow: MessageEditFlow;
  running: boolean;
  sending: boolean;
  error: string;
  onCancel: () => void;
  onOpenFile?: (path: string, worktree: string) => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const edit = flow.edit;
  if (!edit) return null;
  const files = flow.files;
  const names = files.map((file) => file.path.split("/").at(-1)).join(", ");
  const conflicts = files.filter((file) => file.conflict).length;
  return (
    <div
      data-message-edit-card
      role="group"
      aria-label="Editing a message"
      className="mb-2 w-full rounded-card bg-surface px-3 py-2 text-13 text-ink shadow-overlay"
      style={{ animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" }}
    >
      <div className="flex min-h-7 items-center gap-2">
        <Icon icon={PencilEdit02Icon} size={14} className="shrink-0 text-ink-3" />
        <p className="min-w-0 flex-1 truncate text-ink-3">
          <span className="font-medium text-ink-2">Editing a message</span> · {editingText(edit.removed)}
          {running && " · the running turn stops first"}
        </p>
        <Button variant="quiet" size={24} data-message-edit-cancel onClick={onCancel} disabled={sending}>
          Cancel
          <ShortcutKeys shortcut="Esc" compact />
        </Button>
      </div>
      {(files.length > 0 || running) && (
        <div className="flex min-h-7 items-center gap-2">
          <label className="flex min-w-0 items-center gap-2">
            <Checkbox checked={edit.undo} onCheckedChange={flow.setUndo} disabled={sending} data-message-edit-undo />
            <span className="shrink-0">
              {files.length ? `Also undo the changes to ${fileCount(files.length)}` : "Also undo the files the removed turns change"}
            </span>
          </label>
          {files.length > 0 && <span className="min-w-0 truncate text-ink-3">{names}</span>}
          {files.length > 0 && (
            <button
              type="button"
              data-message-edit-review
              onClick={() => setReviewing((open) => !open)}
              className="shrink-0 font-semibold text-accent-ink hover:underline"
            >
              {reviewing ? "Hide" : "Review"}
            </button>
          )}
        </div>
      )}
      {edit.undo && conflicts > 0 && !reviewing && (
        <p className="text-12 text-orange-ink">
          {fileCount(conflicts)} changed after those turns: Review to keep {conflicts === 1 ? "it" : "them"} or undo {conflicts === 1 ? "it" : "them"}.
        </p>
      )}
      {reviewing && files.length > 0 && (
        <ul data-message-edit-files className="-mx-3 mt-1 max-h-48 overflow-y-auto border-t border-line">
          {files.map((file) => (
            <FileRow
              key={file.key}
              file={file}
              intent="Undo"
              decision={flow.edit?.decisions[file.key]}
              disabled={sending || !edit.undo}
              onChoose={(decision) => flow.choose(file.key, decision)}
              onOpen={onOpenFile ? () => onOpenFile(file.path, file.worktree) : undefined}
            />
          ))}
        </ul>
      )}
      <InlineError size={12}>{error}</InlineError>
    </div>
  );
}
