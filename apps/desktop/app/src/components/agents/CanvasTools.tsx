import type { ReactNode } from "react";
import { Cursor01Icon, HandIcon } from "@hugeicons/core-free-icons";
import Tooltip from "../primitives/Tooltip";
import { Icon } from "../primitives/Icon";
import { useCanvasKeys } from "./comment-key";

const POINTER_KEY = "V";
const HAND_KEY = "H";

export function CanvasToolButton({
  label,
  tip = label,
  keyHint,
  icon,
  pressed,
  slot,
  tone = "plain",
  disabled,
  onClick,
}: {
  label: string;
  tip?: string;
  keyHint: string;
  icon: Parameters<typeof Icon>[0]["icon"];
  pressed: boolean;
  slot: string;
  tone?: "plain" | "accent";
  disabled?: boolean;
  onClick: () => void;
}) {
  const on = tone === "accent" ? "bg-accent-tint text-accent-ink" : "bg-hover-2 text-ink";
  return (
    <Tooltip label={tip} keyHint={keyHint} asChild>
      <button
        type="button"
        data-slot={slot}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={`grid size-7 place-items-center rounded-full transition-colors disabled:opacity-40 ${pressed ? on : "text-ink-2 enabled:hover:bg-hover"}`}
      >
        <Icon icon={icon} size={16} />
      </button>
    </Tooltip>
  );
}

export type CanvasTool = "pointer" | "hand" | "comment";

/** The canvas's tools: Pointer views and tries designs, Hand drags the canvas from anywhere; `comment` adds Comment. */
export function CanvasTools({ tool, onTool, comment }: { tool: CanvasTool; onTool: (tool: CanvasTool) => void; comment?: ReactNode }) {
  useCanvasKeys(true, { [POINTER_KEY]: () => onTool("pointer"), [HAND_KEY]: () => onTool("hand") });
  return (
    <div role="group" aria-label="Paradise tools" className="flex items-center gap-0.5">
      <CanvasToolButton
        label="View and try designs"
        keyHint={POINTER_KEY}
        icon={Cursor01Icon}
        pressed={tool === "pointer"}
        slot="artifact-mode-view"
        onClick={() => onTool("pointer")}
      />
      <CanvasToolButton
        label="Move around"
        keyHint={HAND_KEY}
        icon={HandIcon}
        pressed={tool === "hand"}
        slot="artifact-mode-hand"
        onClick={() => onTool("hand")}
      />
      {comment}
    </div>
  );
}
