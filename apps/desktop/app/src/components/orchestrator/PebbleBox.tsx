import { useRef, useState, type ComponentProps } from "react";
import { gazeToward } from "../../lib/orchestrator-board";
import { useOrchestrator } from "../../lib/orchestrator-store";
import { Mascot, type Look } from "./Mascot";
import { OrchestratorBox } from "./OrchestratorBox";

/** The compact box with the Pebble before it, watching the caret as you type. */
export function PebbleBox({ mascotSize = 32, ...box }: Omit<ComponentProps<typeof OrchestratorBox>, "leading" | "onCaret"> & { mascotSize?: number }) {
  const color = useOrchestrator().settings.mascotColor;
  const [look, setLook] = useState<Look>(null);
  const mascot = useRef<HTMLSpanElement>(null);
  return (
    <OrchestratorBox
      size="compact"
      {...box}
      leading={
        <span ref={mascot} className="flex">
          <Mascot size={mascotSize} color={color} look={look} followPointer />
        </span>
      }
      onCaret={(caret) => setLook(caret && mascot.current ? gazeToward(mascot.current.getBoundingClientRect(), caret) : null)}
    />
  );
}
