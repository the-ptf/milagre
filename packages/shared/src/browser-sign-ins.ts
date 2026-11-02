// Sign-ins in the Browser panel, the same on the Mac's Settings › Browser and the phone's. This Mac's Chats share one
// session, and each other computer's Chats share one of their own on this Mac (apps/desktop/electron/
// browser-remote-sessions.cjs); signing one out clears it on the Mac that draws the pages.

export const SIGN_INS_TITLE = "Sign-ins";
export const SIGN_OUT = "Sign out";
export const SIGNING_OUT = "Signing out…";
export const SIGNED_OUT = "Signed out";

/** A row's line: whose pages it signs out. `computer` is null for this Mac. */
export function signOutHint(computer: string | null): string {
  return computer
    ? `Signs the Browser panel pages of ${computer}'s Chats out of every site, and clears their cookies and site data.`
    : "Signs the Browser panel pages of this Mac's Chats out of every site, and clears their cookies and site data.";
}

/** Under the phone's list, which names each session without a line of its own. */
export const SIGN_INS_FOOTER = "Sign out clears the cookies and site data of a computer's Chats' Browser panel pages, so they sign in to every site again.";

/** One Browser panel session on a Mac, as browser:sign-ins lists it: this Mac's ("local", name null) or a computer's. */
export type BrowserSignIns = { sessions: { id: string; name: string | null }[] };
