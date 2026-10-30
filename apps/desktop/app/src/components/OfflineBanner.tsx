/** Over an offline computer's chat (design sidebar-c-sections v3): the last copy it sent, readable, nothing sendable. */
export function OfflineBanner({ text, empty }: { text: string; empty: boolean }) {
  return (
    <div className="mx-auto mt-3 mb-1 w-full max-w-3xl shrink-0 px-5">
      <div role="status" data-offline-banner className="flex items-center gap-2 rounded-card bg-hover px-3 py-2 text-12 text-ink-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-ink-4" />
        {text}
      </div>
      {empty && (
        <p data-offline-empty className="mt-6 text-center text-13 text-ink-3">
          No copy of this Chat on this Mac yet.
        </p>
      )}
    </div>
  );
}
