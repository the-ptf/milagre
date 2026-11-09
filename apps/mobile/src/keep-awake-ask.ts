import type { ShowAlert } from "./confirm-store";

type Caller = { call<T>(method: string, args?: unknown[]): Promise<T> };
type Storage = { getItemAsync: (key: string) => Promise<string | null>; setItemAsync: (key: string, value: string) => Promise<void> };
const KEY = "milagre.keep-awake-never-ask.v1";
const MAX_ENTRIES = 40;

/** A computer's id (a URL) as a short hash, so the saved value stays small and holds no address. */
function hostHash(hostId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < hostId.length; i++) hash = Math.imul(hash ^ hostId.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16);
}

function parse(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw || "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** The computers this phone was told never to ask about keeping awake again. */
export function createKeepAwakeNeverAsk(storage: Storage) {
  let pending = Promise.resolve();
  const read = (): Promise<string[]> => storage.getItemAsync(KEY).then(parse, () => []);
  return {
    async has(hostId: string): Promise<boolean> {
      await pending;
      return (await read()).includes(hostHash(hostId));
    },
    add(hostId: string): Promise<void> {
      const entry = hostHash(hostId);
      const save = async () => {
        const entries = (await read()).filter((existing) => existing !== entry);
        await storage.setItemAsync(KEY, JSON.stringify([...entries, entry].slice(-MAX_ENTRIES)));
      };
      pending = pending.then(save).catch(() => {});
      return pending;
    },
  };
}

/** The questions name their computer: with two Macs on screen (a split on iPad), each says which one it changes. */
export const keepAwakeTitle = (name: string) => `Keep ${name} awake?`;
const keepAwakeMessage = (name: string) =>
  `When ${name} sleeps, this phone can't reach it. Keep it awake while Milagre runs? Its screen can still turn off. Plugged in, it stays awake with the lid closed.`;
export const keepAwakeFailedTitle = (name: string) => `Couldn't keep ${name} awake`;

// The computers a question is being read or shown for, with whether its Chat is still on screen: two panes on one Mac
// (a split on iPad) ask once, and a Chat left behind doesn't hold up the next one's question.
const asking = new Map<string, () => boolean>();

// One computer's question at a time, with its retries: the sheet replaces a question still open, so the next waits
// for this one's answer instead of dismissing it.
let turn: Promise<void> = Promise.resolve();
function inTurn(work: () => Promise<void>): Promise<void> {
  const mine = turn.then(work);
  turn = mine.catch(() => {});
  return mine;
}

const failure = (error: unknown) => (error instanceof Error && error.message ? error.message : "The Mac didn't answer.");

/**
 * Opening a Chat asks to keep its Mac awake while that Mac lets itself sleep, until the answer is Keep awake or
 * Don't ask again. A Mac that can't say (older, or a phone confined to one folder) is never asked about. `isCurrent`
 * says the Chat is still the one on screen: a read that answers after another Chat opened shows nothing, and an answer
 * to a Chat that went away changes nothing. A save that fails says why and offers Try again. Questions about different
 * Macs wait their turn, each named for its own Mac.
 */
export async function askKeepAwake({
  client,
  hostId,
  hostName,
  neverAsk,
  ask,
  isCurrent = () => true,
}: {
  client: Caller;
  hostId: string;
  /** The computer's name as the phone lists it; "the Mac" when it has none. */
  hostName?: string;
  neverAsk: Pick<ReturnType<typeof createKeepAwakeNeverAsk>, "has" | "add">;
  ask: ShowAlert;
  isCurrent?: () => boolean;
}): Promise<void> {
  if (asking.get(hostId)?.()) return;
  asking.set(hostId, isCurrent);
  const name = hostName?.trim() || "the Mac";
  try {
    if (await neverAsk.has(hostId)) return;
    let enabled: unknown;
    try {
      enabled = (await client.call<{ enabled?: unknown } | null>("keep-awake:settings:read", []))?.enabled;
    } catch {
      return;
    }
    // Only an answer of off asks: a Mac that answers anything else (an older one) can't say.
    if (enabled !== false) return;
    const save = (): Promise<void> =>
      client.call("keep-awake:settings:save", [{ enabled: true }]).then(
        () => undefined,
        (error: unknown) => {
          if (!isCurrent()) return undefined;
          return new Promise<void>((resolve) =>
            ask(keepAwakeFailedTitle(name), failure(error), [
              { text: "Try again", onPress: () => void save().then(resolve) },
              { text: "Not now", style: "cancel", onPress: resolve },
            ]),
          );
        },
      );
    await inTurn(async () => {
      if (!isCurrent()) return;
      await new Promise<void>((resolve) =>
        ask(keepAwakeTitle(name), keepAwakeMessage(name), [
          { text: "Keep awake", onPress: () => void (isCurrent() ? save() : Promise.resolve()).then(resolve) },
          { text: "Don't ask again", onPress: () => void neverAsk.add(hostId).then(resolve) },
          { text: "Not now", style: "cancel", onPress: resolve },
        ]),
      );
    });
  } finally {
    if (asking.get(hostId) === isCurrent) asking.delete(hostId);
  }
}
