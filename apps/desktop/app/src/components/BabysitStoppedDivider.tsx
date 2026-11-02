import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { babysitStoppedText } from "@milagre/shared/babysit";
import type { BabysitStoppedContext } from "@milagre/shared/model";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

/** Where the Heartbeat babysitting the Chat's PR ended: a hairline with "Stopped babysitting PR #1: merged." on it. */
export function BabysitStoppedDivider({ context }: { context: BabysitStoppedContext }) {
  return <TranscriptDivider data-babysit-stopped-divider icon={Pulse01Icon} label={babysitStoppedText(context)} />;
}
