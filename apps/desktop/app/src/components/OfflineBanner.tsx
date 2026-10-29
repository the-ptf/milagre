/** Over an offline computer's chat (design sidebar-c-sections v3): the last copy it sent, with messages kept locally until it returns. */
export function OfflineBanner({ text, empty }: { text: string; empty: boolean }) {
  return (
    <div className="mx-auto mt-3 mb-1 w-full max-w-3xl shrink-0 px-5">
      <div role="status" data-offline-banner className="flex items-center gap-2.5 rounded-[10px] bg-orange-tint px-3 py-2 text-12 text-orange-ink">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: "var(--orange)" }} />
        {text}
      </div>
      {empty && (
        <p data-offline-empty className="mt-6 text-center text-[13px] text-ink-3">
          No copy of this chat on this Mac yet.
        </p>
      )}
    </div>
  );
}
