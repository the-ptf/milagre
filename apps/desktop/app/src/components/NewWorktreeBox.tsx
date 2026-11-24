import { useEffect, useState } from "react";
import { shortcutCommand, useShortcutLabel } from "../lib/keybindings";
import { offlinePlaceholder } from "../lib/computers";
import { appShortcutsBlocked } from "../lib/modal";
import { QuickBoxDialog } from "./QuickBoxDialog";
import { QuickPromptBox } from "./QuickPromptBox";
import type { QuickImage } from "./useQuickImages";

const OPEN_EVENT = "milagre:new-worktree-box";
const MAX_IMAGES = 10;

export const openNewWorktreeBox = () => window.dispatchEvent(new Event(OPEN_EVENT));

type BoxProps = { projectName: string; offlineName: string | null; onStart: (text: string, images: QuickImage[], open: boolean) => void };

export function NewWorktreeBox({ linkOpen, ...box }: BoxProps & { linkOpen: boolean }) {
  const [open, setOpen] = useState(false);
  const enabled = !linkOpen;
  useEffect(() => {
    if (!enabled) return;
    const show = () => setOpen(true);
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || appShortcutsBlocked() || shortcutCommand(event) !== "worktree.new") return;
      event.preventDefault();
      show();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, [enabled]);
  return open && enabled ? <Box {...box} onClose={() => setOpen(false)} /> : null;
}

function Box({ projectName, offlineName, onStart, onClose }: BoxProps & { onClose: () => void }) {
  const [started, setStarted] = useState(0);
  const stayKey = useShortcutLabel("chat.sendStay");
  const hints = [["Enter", "start and open"], ...(stayKey ? [[stayKey, "start, stay here"] as const] : []), ["Esc", "close"]] as const;
  return (
    <QuickBoxDialog label="New worktree" hints={hints} onClose={onClose} data-new-worktree-box>
      <QuickPromptBox
        autoFocus
        maxImages={MAX_IMAGES}
        label={`First message for a new worktree in ${projectName}`}
        placeholder={offlineName ? offlinePlaceholder(offlineName) : "What should the agent do?"}
        header={
          <div className="flex items-center justify-between gap-3 text-11 text-ink-3">
            <span className="truncate">New worktree in {projectName}</span>
            {started > 0 && (
              <span role="status" className="shrink-0 tabular-nums">
                {started} started
              </span>
            )}
          </div>
        }
        submit={async (text, images, stay) => onStart(text, images, !stay)}
        onSent={(_, __, stay) => (stay ? setStarted((count) => count + 1) : onClose())}
        onEscape={onClose}
      />
    </QuickBoxDialog>
  );
}
