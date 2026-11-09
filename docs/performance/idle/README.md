# Idle and Chat memory measurements

Measured on 2026-10-20, macOS arm64, Node 24.13.0, Electron 44.5.1, development React. These are isolated fixtures using production renderer components and paging hooks. They do not measure a real provider's CPU/RAM or establish a whole-app idle memory reduction.

## Hidden display work

`node scripts/benchmark-idle-display.cjs` mounts the production elapsed-time indicator in an isolated Electron window. It samples visible, hidden and returned states, including renderer heap after GC. `MILAGRE_IDLE_BASELINE=1` reads the original indicator and CSS from baseline commit `691c2d47`; `MILAGRE_IDLE_BASELINE_REF` overrides that commit for later comparisons.

| Measurement                                          | Before | After |
| ---------------------------------------------------- | -----: | ----: |
| Visible React commits, requested three-second sample |     31 |    30 |
| Hidden React commits, requested three-second sample  |      3 |     0 |

Chromium already throttles hidden timers; the change removes their display work entirely. Heap remained about 11 MB in this tiny fixture. There is no measured RAM win from pausing the clock. GC and hidden-renderer scheduling can delay the sampling calls; these are requested sample durations, not precise latency measurements. Returning refreshes elapsed time from the wall clock, independently verified by deterministic clock and mobile adapter tests.

Raw captures: [before](display-before.json), [after](display-after.json). Process CPU/memory samples were omitted from the committed captures because the short, loaded-machine sample cannot support a CPU-percentage claim.

## Chat history retention

Inactive desktop pages have an eight-Chat/eight-MiB estimated payload budget; mobile has six Chats/four MiB. Each inactive page keeps the latest twenty user turns. The byte estimate is twice each immutable message's serialized length, cached weakly by message identity. It bounds retained serialized payload, not every allocation in a renderer. Active subscriptions are exempt so Find, reading position and live content remain intact.

The GC regression visits thirty Chats with 1,000 messages each and builds their completed-history projections. Once inactive, each retained alternating-message Chat holds forty messages, rather than 1,000 (96% fewer). After GC, all sixty weak references to obsolete full arrays/projections are cleared; eight recent tails remain. This is a bounded-retention assertion, not a claim of 96% lower app RAM.

`npm test -- --only test-chat-subscription-handoff` mounts both production paging hooks with real ReactDOM in Electron, including StrictMode. It preserves 120 loaded messages across tile/focused-view handoffs and verifies trimming and full reload after a true leave. Cleanup waits one microtask so temporary zero-reader transitions cannot trim or evict visible history.

The production-hook lifecycle regressions cover leaving/reopening while an older page is in flight, discarding a response for a trimmed cursor, reading the complete history again, and cancelling further Find reads without leaving the Chat. Requests already in flight can finish, but their pages cannot create gaps or restart an abandoned full-history load.

## Streaming

Both clients reuse completed-history projections while the live reply changes. A 100-read regression scans completed steps once, retains projection identity, and refreshes when the immutable saved-message array changes. Weak ownership allows an obsolete projection to be collected with its source.

The existing full-App Chat-flow benchmark gave these medians (three trials each). The background workload emits forty updates to a different Chat. Numbers are React render time, not end-to-end latency; the machine also ran other development work, so they are observations rather than budgets or guarantees.

| Saved messages | Opening render, before / after | Background-update render, before / after |
| -------------- | -----------------------------: | ---------------------------------------: |
| 40             |                 79.8 / 86.1 ms |                           69.3 / 68.4 ms |
| 300            |                 57.0 / 68.5 ms |                          106.9 / 77.5 ms |
| 1,000          |                 78.1 / 67.1 ms |                          126.3 / 66.8 ms |

Raw captures: [before](chat-flow-before.json), [after](chat-flow-after.json). Small-history opening was slower in these samples; no uniform speedup is claimed. Existing desktop event handlers already use stable wrappers. No measured callback-retention defect was established, so there is no blanket callback rewrite.

## User behavior

Agent processing, state events, attention indicators, notifications and visible floating inbox polling remain active. Desktop clocks and CSS animations pause when their own document is hidden; unfocused visible windows stay active. Mobile elapsed labels and running/shimmer/Ultracode animations also stop when the app is backgrounded or the screen is covered. History expanded by Find stays readable until the Chat loses its last subscriber after the current React commit; cancelling Find stops additional pagination.

## Repeat

```sh
MILAGRE_IDLE_BASELINE=1 MILAGRE_BENCHMARK_OUTPUT=/tmp/display-before.json node scripts/benchmark-idle-display.cjs
MILAGRE_BENCHMARK_OUTPUT=/tmp/display-after.json node scripts/benchmark-idle-display.cjs
MILAGRE_BENCHMARK_OUTPUT=/tmp/chat-flow.json npm run benchmark:chat-flow
node --test packages/shared/src/display-clock.test.ts packages/shared/src/chat-window-cache.test.ts packages/shared/src/chat-history.test.ts scripts/chat-window-lifecycle.test.cjs scripts/chat-history-retention.test.cjs
node --test --test-name-pattern='display clocks' scripts/mobile-ui.test.cjs
```

Run visible Electron checks sequentially: another window can steal focus from native floating-panel activation checks. Full desktop startup, Chat timer, Find, Project cache, floating inbox and native floating-panel checks were exercised. The mobile UI harness covers both shared logic and screen handlers; the installed iOS 27 debug app on Milagre Mobile Bugs QA loaded this checkout through Metro against the isolated scripted demo host. It displayed a running 16.8-second turn after background/foreground and received the finished response. Android native behavior and real-provider performance were not measured. No native build or OTA was published; the iOS fingerprint matched the latest finished build.
