import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { babysitStoppedText } from "@milagre/shared/babysit";
import type { BabysitStoppedContext } from "@milagre/shared/model";
import { TranscriptDivider } from "./ui";

export function BabysitStoppedDivider({ context }: { context: BabysitStoppedContext }) {
  return <TranscriptDivider label={babysitStoppedText(context)} icon={Pulse01Icon} />;
}
