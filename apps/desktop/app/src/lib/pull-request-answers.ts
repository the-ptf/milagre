import type { PullRequest } from "../model.ts";

type Answer = PullRequest | null;

export const samePullRequest = (a: Answer | undefined, b: Answer | undefined) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function withPullRequests(held: Record<string, Answer>, found: Record<string, Answer>): Record<string, Answer> {
  const changed = Object.entries(found).filter(([path, pr]) => !Object.hasOwn(held, path) || !samePullRequest(held[path], pr));
  return changed.length ? { ...held, ...Object.fromEntries(changed.map(([path, pr]) => [path, pr && structuredClone(pr)])) } : held;
}

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
