import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { babysitStoppedText } from "@milagre/shared/babysit";
import type { BabysitStoppedContext } from "@milagre/shared/model";
import { TranscriptDivider } from "./ui";

/** Where the Heartbeat babysitting the Chat's PR ended, as on desktop: "Stopped babysitting PR #1: merged." */
export function BabysitStoppedDivider({ context }: { context: BabysitStoppedContext }) {
  return <TranscriptDivider label={babysitStoppedText(context)} icon={Pulse01Icon} />;
}
