import type { PendingComputer } from "../electron";
import { thisComputer } from "./shortcut-hints.ts";

/** The prompt's question: the name the computer sent in its hello, or what it is when it sent none. */
export const allowQuestion = (request: Pick<PendingComputer, "name">) => `${request.name ?? "A computer"} wants to drive ${thisComputer}'s chats`;

/** Under the question: what Allow gives it, and how to take it back. */
export const ALLOW_DETAIL = "It can do anything this window can, except pair and remove devices. You can remove it any time in Settings › Devices.";
