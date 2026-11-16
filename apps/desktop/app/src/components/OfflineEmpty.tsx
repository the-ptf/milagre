import { thisComputer } from "../lib/shortcut-hints";

export function OfflineEmpty() {
  return (
    <p data-offline-empty className="mx-auto mt-9 w-full max-w-3xl shrink-0 px-5 text-center text-13 text-ink-3">
      No copy of this Chat on {thisComputer} yet.
    </p>
  );
}
