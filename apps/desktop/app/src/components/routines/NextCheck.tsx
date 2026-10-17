import { clock } from "@milagre/shared/routines";
import { useRoutines } from "../../lib/routines";

/** "Next check 10:45" under a Chat's transcript while an enabled heartbeat checks back on it. */
export function NextCheck({ chatKey }: { chatKey: string }) {
  const { routines } = useRoutines();
  const next = routines
    .filter((routine) => routine.enabled && routine.target.kind === "chat" && routine.target.chatId === chatKey)
    .map((routine) => routine.nextRunAt)
    .filter((at): at is number => typeof at === "number")
    .reduce<number | null>((soonest, at) => (soonest === null || at < soonest ? at : soonest), null);
  if (next === null) return null;
  return (
    <p data-next-check className="w-full text-center text-[12px] text-ink-3">
      Next check {clock(next)}
    </p>
  );
}
