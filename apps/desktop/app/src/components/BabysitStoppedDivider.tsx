import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { babysitStoppedText } from "@milagre/shared/babysit";
import type { BabysitStoppedContext } from "@milagre/shared/model";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

export function BabysitStoppedDivider({ context }: { context: BabysitStoppedContext }) {
  return <TranscriptDivider data-babysit-stopped-divider icon={Pulse01Icon} label={babysitStoppedText(context)} />;
}
