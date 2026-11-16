import type { PendingComputer } from "../electron";
import { thisComputer } from "./shortcut-hints.ts";

export const allowQuestion = (request: Pick<PendingComputer, "name">) => `${request.name ?? "A computer"} wants to drive ${thisComputer}'s chats`;

export const ALLOW_DETAIL = "It can do anything this window can, except pair and remove devices. You can remove it any time in Settings › Phone & sharing.";
