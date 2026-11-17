import { useRef, useState, type ComponentProps } from "react";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { gazeToward } from "../../lib/orchestrator-board";
import { useOrchestrator } from "../../lib/orchestrator-store";
import { Mascot, type Look } from "./Mascot";
import { OrchestratorBox } from "./OrchestratorBox";

type BoxProps = Omit<ComponentProps<typeof OrchestratorBox>, "leading" | "onCaret" | "onSent">;

/** The compact box with the Pebble before it, watching the caret as you type. `onSent` also gets where the Pebble sat. */
export function PebbleBox({
  mascotSize = 32,
  onSent,
  ...box
}: BoxProps & { mascotSize?: number; onSent?: (task: OrchestratorTask, from: DOMRect, pebble: DOMRect | null) => void }) {
  const color = useOrchestrator().settings.mascotColor;
  const [look, setLook] = useState<Look>(null);
  const mascot = useRef<HTMLSpanElement>(null);
  return (
    <OrchestratorBox
      size="compact"
      {...box}
      onSent={onSent && ((task, from) => onSent(task, from, mascot.current?.getBoundingClientRect() ?? null))}
      leading={
        <span ref={mascot} className="flex">
          <Mascot size={mascotSize} color={color} look={look} followPointer />
        </span>
      }
      onCaret={(caret) => setLook(caret && mascot.current ? gazeToward(mascot.current.getBoundingClientRect(), caret) : null)}
    />
  );
}
