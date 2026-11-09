# Idle performance implementation plan

**Goal:** Reduce background display work and retained Chat history on desktop and mobile, with measured regressions.

**Spec:** The approved five-step plan in this Chat: establish a baseline, pause hidden display work, bound inactive Chat memory, reduce streaming calculations, verify both platforms.

**Constraints:** Keep the ten-minute agent timeout. Preserve event delivery, notifications, visible floating inbox polling, drafts, active reading position and background work. JS-only mobile changes, no new native dependencies or builds. Do not modify the live user's state for benchmarks.

## Tasks

1. Capture baseline with existing Chat-flow fixture and new bounded-retention/visibility regressions. Report synthetic measurements separately from live app memory. Record any unavailable native verification.
2. Introduce a shared visibility-aware display clock, with desktop document visibility and mobile app/screen visibility adapters. Pause desktop CSS animations when its document is hidden. Recompute wall-clock time on return. Verify hide/show, unmount and notification independence.
3. Introduce a shared Chat window cache with desktop eight-Chat/eight-MiB and mobile six-Chat/four-MiB estimated payload budgets for inactive entries. Keep active readers intact. Trim inactive entries to twenty user turns, evict least-recent entries under pressure, and stop abandoned Find pagination. Test re-entry, late responses, concurrent subscribers, metadata and large messages.
4. Reuse completed-history projections while live output changes, on both clients. Inspect stable callback use; change retention only when evidence supports it. Test stable references, updated history and bounded ownership.
5. Run focused regressions, desktop checks, root/mobile typecheck and lint, unit suite, fingerprint comparison, and compatible native device checks. Compare before/after; run a fresh whole-change review.

## Review focus

- An unsubscribed or evicted Chat must reload correctly and cannot loop fetching all history.
- Active readers, pending sends and background work must not be truncated by cache pressure.
- The floating bar and attention notifications must keep receiving state when the main window is hidden.
- Returning to a window/screen must immediately show elapsed wall time.
- Shared projections must refresh after changes and must not keep obsolete histories alive.

## Verification

- Shared Node tests for cache and clock, desktop/mobile paging tests, native hook harness and Electron timer/cache tests.
- `npm run benchmark:chat-flow`, plus isolated display-clock and retained-payload measurements.
- `npm run typecheck`, `npm run typecheck:mobile`, `npm run lint`, mobile lint, `npm test -- --unit`.
- Relevant Electron Chat timer, Find, paging/cache, notification/floating bar and desktop startup checks.
