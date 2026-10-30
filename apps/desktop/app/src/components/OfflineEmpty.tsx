import { thisComputer } from "../lib/shortcut-hints";

/** An offline computer's Chat with no copy on this Mac yet; the composer's tray says the computer is offline. */
export function OfflineEmpty() {
  return (
    <p data-offline-empty className="mx-auto mt-9 w-full max-w-3xl shrink-0 px-5 text-center text-13 text-ink-3">
      No copy of this chat on {thisComputer} yet.
    </p>
  );
}
