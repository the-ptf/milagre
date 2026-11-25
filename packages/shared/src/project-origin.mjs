/**
 * A remote URL as "host/owner/repo", lowercased: "git@github.com:Owner/Repo.git", "https://github.com/owner/repo" and
 * "ssh://git@github.com/owner/repo/" all read "github.com/owner/repo". A local-path remote names a folder only that
 * computer has, so it reads null, as does no remote.
 */
export function originId(url) {
  if (typeof url !== "string") return null;
  const value = url.trim();
  let host;
  let pathname;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:") return null;
    host = parsed.hostname;
    pathname = parsed.pathname;
  } else {
    // scp-like "user@host:owner/repo"; a one-letter host is a Windows drive, not a server.
    const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/)(.+)$/.exec(value);
    if (!scp) return null;
    host = scp[1];
    pathname = scp[2];
  }
  const repo = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return host && repo ? `${host}/${repo}`.toLowerCase() : null;
}

/**
 * The choices with one origin on several computers as one entry, in the place of its first copy, which it keeps as its
 * own fields; `copies` lists every computer's copy in the order given. A choice with no origin, or a second clone on a
 * computer that already has one, stays on its own.
 */
export function groupByOrigin(choices) {
  const groups = [];
  const byOrigin = new Map();
  for (const choice of choices) {
    const group = choice.origin ? byOrigin.get(choice.origin) : undefined;
    if (group && !group.copies.some((copy) => copy.computerId === choice.computerId)) {
      group.copies.push(choice);
      continue;
    }
    const next = { ...choice, copies: [choice] };
    groups.push(next);
    if (choice.origin && !group) byOrigin.set(choice.origin, next);
  }
  return groups;
}

/**
 * A group's copies in the order to open them: the picked one, then each other copy that is not offline, this
 * computer's first.
 */
export function copiesToTry(copies, picked, isHere) {
  const others = copies.filter((copy) => copy !== picked && copy.online !== false && copy.offline !== true);
  return [picked, ...others.toSorted((a, b) => Number(isHere(b)) - Number(isHere(a)))];
}

/**
 * Opens the first copy that opens. `open` throws to move on to the next copy and returns undefined to stop (the person
 * went somewhere else meanwhile). Each failure reads "computer: why", so one computer's refusal never hides which one.
 */
export async function openFirstCopy(copies, open, failure) {
  const failures = [];
  for (const copy of copies) {
    try {
      const opened = await open(copy);
      return opened === undefined ? { copy: undefined, failures, stopped: true } : { copy, failures, stopped: false };
    } catch (error) {
      failures.push(failure(copy, error));
    }
  }
  return { copy: undefined, failures, stopped: false };
}

export function copyOpenNotice(failures, openedOn) {
  if (!failures.length) return null;
  return openedOn ? `${failures.join(" ")} Opened it on ${openedOn} instead.` : failures.join(" ");
}
