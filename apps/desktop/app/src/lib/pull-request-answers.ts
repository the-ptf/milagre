import type { PullRequest } from "../model.ts";

// gh answers the same status over and over between a PR's changes. Merged into what the window holds, an answer equal
// to the held one leaves the held object as it was, so the rows and composer reading it don't render again for nothing.

type Answer = PullRequest | null;

/** Whether two PR answers say the same thing (plain JSON from the host, so equal fields mean equal answers). */
export const samePullRequest = (a: Answer | undefined, b: Answer | undefined) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** `held` with the PRs in `found` (by Worktree path, or by ref), or `held` itself when each is what it holds already. */
export function withPullRequests(held: Record<string, Answer>, found: Record<string, Answer>): Record<string, Answer> {
  const changed = Object.entries(found).filter(([path, pr]) => !Object.hasOwn(held, path) || !samePullRequest(held[path], pr));
  return changed.length ? { ...held, ...Object.fromEntries(changed) } : held;
}

/** `held` with the Chats' PRs in `found` (by folder, then ref), keeping every folder whose answers didn't change as it was. */
export function withChatPullRequests(
  held: Record<string, Record<string, Answer>>,
  found: Record<string, Record<string, Answer>>,
): Record<string, Record<string, Answer>> {
  let next = held;
  for (const [path, byRef] of Object.entries(found)) {
    const before = held[path] ?? {};
    const merged = withPullRequests(before, byRef);
    if (merged === before && Object.hasOwn(held, path)) continue;
    if (next === held) next = { ...held };
    next[path] = merged;
  }
  return next;
}
