import { Clock01Icon, Comment01Icon, Flag02Icon, Pulse01Icon, Tag01Icon, UserCheck01Icon, WebhookIcon } from "@hugeicons/core-free-icons";
import type { Routine } from "@milagre/shared/model";
import { isHeartbeat } from "../../lib/routines";

/** A Routine's icon (its row's tile, its page's, a Chat's Routine chip): a pulse for a heartbeat, else what starts it. */
export function routineIcon(routine: Routine): typeof Pulse01Icon {
  if (isHeartbeat(routine)) return Pulse01Icon;
  const { trigger } = routine;
  if (trigger.kind === "webhook") return WebhookIcon;
  if (trigger.kind === "schedule") return Clock01Icon;
  switch (trigger.event) {
    case "assigned":
      return UserCheck01Icon;
    case "state":
      return Flag02Icon;
    case "comment":
      return Comment01Icon;
    default:
      return Tag01Icon;
  }
}
