import { CHATS_PLACEHOLDER, CHATS_TRAY_LABEL, JUST_CHAT_HEADING, type ProjectKind } from "@milagre/shared/chats-home";

type ChatsLook = { heading: string; tray: "chats"; trayLabel: string; placeholder: string };
export type NewChatLook = { heading: string; tray: "project" } | ChatsLook;

export function newChatLook(kind: "chats"): ChatsLook;
export function newChatLook(kind: ProjectKind | undefined): NewChatLook;
export function newChatLook(kind: ProjectKind | undefined): NewChatLook {
  if (kind === "chats") return { heading: JUST_CHAT_HEADING, tray: "chats", trayLabel: CHATS_TRAY_LABEL, placeholder: CHATS_PLACEHOLDER };
  return { heading: "Start building in", tray: "project" };
}

/**
 * The heading's stacking layer. Its Project dropdown has to cover the composer, so the wrapper is raised while the dropdown is
 * open; closed, it stays under the composer's `/` and `@` menu (z-20), which would otherwise show the heading through it.
 */
export function headingLayer(pickerOpen: boolean): string {
  return pickerOpen ? "z-30" : "";
}
