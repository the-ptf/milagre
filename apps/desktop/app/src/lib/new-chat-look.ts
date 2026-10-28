import type { ProjectKind } from "@milagre/shared/chats-home";

type ChatsLook = { heading: string; tray: "chats"; trayLabel: string; placeholder: string };
/** What a new Chat's screen says: the heading before the Project button, and what the tray above the composer holds. */
export type NewChatLook = { heading: string; tray: "project" } | ChatsLook;

/** A Chats home draft has no Project to build in: no isolation, branch or issue to pick, only where it runs. */
export function newChatLook(kind: "chats"): ChatsLook;
export function newChatLook(kind: ProjectKind | undefined): NewChatLook;
export function newChatLook(kind: ProjectKind | undefined): NewChatLook {
  if (kind === "chats") return { heading: "Just chat", tray: "chats", trayLabel: "Yapping around", placeholder: "Ask anything" };
  return { heading: "Start building in", tray: "project" };
}

/**
 * The heading's stacking layer. Its Project dropdown has to cover the composer, so the wrapper is raised while the dropdown is
 * open; closed, it stays under the composer's `/` and `@` menu (z-20), which would otherwise show the heading through it.
 * A heading that is no longer shown never holds the layer, whatever the last reported state was.
 */
export function headingLayer(pickerOpen: boolean, shown = true): string {
  return pickerOpen && shown ? "z-30" : "";
}
