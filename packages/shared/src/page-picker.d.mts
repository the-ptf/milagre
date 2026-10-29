import type { PageElement } from "./page-comments.ts";

export type PagePin = { n: number; selector: string; point?: { x: number; y: number }; text: string; state: "pending" | "open" | "resolved"; note?: string };

/** A script that evaluates to a promise of the element the user picks on the page, null if cancelled, undefined if replaced. */
export function pagePickScript(accent?: string): string;
export const PAGE_PICK_CANCEL: string;
export function pagePinsScript(pins: PagePin[], colors?: { accent?: string; green?: string }): string;
export function pagePinsHidden(hidden: boolean): string;
export type { PageElement };
