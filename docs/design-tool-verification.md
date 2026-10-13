# Design tool live verification

The real-provider workflow passed on October 12, 2026 with Codex CLI 0.160.0, `gpt-6.1-sol`, low reasoning effort and normal speed. It used the production daemon, Chat runtime, MCP server, provider adapter and artifact store.

1. The model called `design_show` and created version 1 with a Chat card.
2. The fixture called the same `artifact:apply` API as the editor to change the subtitle and save version 2. An edit against version 1 was rejected.
3. The model called `design_read`, then `design_apply` against version 2 to change the heading. Version 3 retained the manual subtitle and every unrelated property, produced a new Chat card, and left version 1 unchanged.

The run exposed a Codex Ask-mode bug: MCP approval requests arrive through `mcpServer/elicitation/request`, which Milagre previously rejected. They now use the existing permission card with allow-once, deny and cancel responses. The adapter declines forms that require additional user input and never sends a permanent approval grant. Provider and permission tests cover these cases.

## Repeat the checks

The structured workflow is opt-in and consumes usage on the existing signed-in Codex account:

```sh
node scripts/live-design-workflow.cjs --live --effort low --output /tmp/design-workflow.json
```

Each fixture creates a temporary Git Project and Milagre profile, disables external MCPs in its ephemeral provider thread, and removes its own Project/profile afterward. It does not copy credentials, change provider configuration, or open an existing Project. Automatic fixture approvals cover only the bundled design skill read and design operations on its own `daily-notes` artifact. An installed skill can require an additional read; authorize that exact Markdown file with `--allow-skill-read /absolute/path/to/skill.md`. Other permissions and questions fail the fixture.

Designs now has one structured authoring path. Its host setting defaults to enabled; switching it off removes the interface and tools, with no HTML fallback. Cached tool calls and comment operations are blocked while it is off. Legacy HTML files remain untouched on disk and cannot be opened or revised.

This is an approved breaking change: Victor explicitly requested removing HTML support rather than maintaining two design paths. The PR and release description must state that older HTML designs and their design-comment UI are retired; transcript feedback remains readable as plain text. The later advisor brief asking to preserve that UI was stale.

The comparative benchmark script was removed with HTML authoring. The measurements below are historical evidence from the implementation that supported both formats; they do not keep an HTML product path alive. That benchmark alternated format order with the same brief, model, effort and tool inventory. Revisions used the creation thread and changed the same heading. The raw results retain failures and token/byte measurements.

## Recorded evidence

Workflow: `/private/var/folders/lx/5641l2p53bl9xb78vs0r60lr0000gn/T/milagre-design-live-58NiEx/workflow-results.json`. Creation took 23.1 seconds; the revision took 10.1 seconds. These timings are workflow evidence, not the matched benchmark.

An initial benchmark batch at `/private/var/folders/lx/5641l2p53bl9xb78vs0r60lr0000gn/T/milagre-design-benchmark-bKRhd9/results.json` retained one successful matched pair, one unpaired structured sample, and three samples stopped by the fixture's skill-read policy. It is setup evidence and is excluded from the final timing comparison below.

## Matched benchmark

All three controlled pairs passed. Structured first drafts were slower by median wall time in this run; structured revisions had a faster median, but HTML won one revision pair.

| Pair   | Structured create | HTML create | Structured revise | HTML revise |
| ------ | ----------------: | ----------: | ----------------: | ----------: |
| 1      |           31.14 s |     38.68 s |            8.79 s |     13.71 s |
| 2      |           31.38 s |     22.18 s |           13.00 s |     15.91 s |
| 3      |           57.80 s |     23.69 s |           10.90 s |     10.42 s |
| Median |           31.38 s |     23.69 s |           10.90 s |     13.71 s |

| Median per turn                     | Structured create | HTML create | Structured revise | HTML revise |
| ----------------------------------- | ----------------: | ----------: | ----------------: | ----------: |
| Validated tool input                |       2,294 bytes | 2,684 bytes |         156 bytes | 2,707 bytes |
| Tool results                        |         110 bytes |    92 bytes |       2,494 bytes | 2,812 bytes |
| Output tokens                       |             1,384 |         930 |               168 |         233 |
| Input tokens excluding cached input |            33,209 |      24,130 |             2,152 |       2,211 |

The smaller structured edit payload is measurable. The 20% median revision-time difference is an early observation from three pairs, not a speed guarantee. First-draft generation did not get faster. Structured sample 1 retried after using pixels for `lineHeight`, whose schema accepts a multiplier; its timing and tokens include that retry. The first drafts were not checked for equal visual quality. Structured revisions were compared property by property; HTML revisions were checked for the changed heading text.

Wall time covers `chat:send` through turn completion, including provider startup on creation, skill reads, tool calls and retries. Fixture approvals are immediate, so human approval time is excluded. Tool byte counts cover arguments accepted by validation; provider token/time measurements include failed attempts. Input tokens sum all model requests in a turn; most input was cached. These are subscription usage measurements, not dollar estimates. Network, caching, output choices and concurrent development work were not controlled.

On Node 24.13.0 / Apple M4 Pro, 100 warm local preparation runs per final artifact measured structured validation/rendering plus preview CSP wrapping at 0.36, 12.90 and 0.94 ms per call (median 0.94 ms). HTML CSP wrapping was below 0.001 ms per call. This excludes browser layout, app startup and network. It does not establish faster display performance. Median stored preview-plus-source payload was 7,484 bytes for structured documents versus 2,524 bytes for HTML, excluding metadata; structured versions retain both JSON and generated HTML. Median compressed preview sizes were 1,116 and 1,149 bytes respectively.

Raw report: `/var/folders/lx/5641l2p53bl9xb78vs0r60lr0000gn/T/milagre-design-benchmark-ibAsxa/results.json`. The command added `--allow-skill-read /Users/victor/.codex/plugins/cache/openai-curated-remote/superpowers/6.4.2/skills/using-superpowers/SKILL.md` and used the same explicit instruction to skip extra process skills for both formats. The bundled skill stayed at SHA-256 `22d1facd7468db1e20497c586b4849112faec68645ea018ead324d4203e4cd00` throughout this batch. Results predate the follow-up clarification of `lineHeight` units.

The original verification passed 91 provider/permission tests and 3 live-harness reporting/approval tests. After removing HTML authoring, 153 targeted backend checks passed across document persistence, rollback, comments, MCP transport, host settings, provider context, skills and phone signals. The remaining structured workflow script exits without starting a provider unless `--live` is supplied.

Changing the host setting blocks tool execution immediately after earlier accepted operations complete. Running replies retain their current provider instructions until the next idle turn; that turn resumes the same provider history with the updated instructions and tool inventory. New advisor sessions read the current setting too.

## Review follow-up

The settings-crash finding was stale: malformed JSON and `null` already disable Designs without stopping the host, and a successful save restores the setting. Those regression tests still pass.

The MCP transport now measures UTF-8 bytes and permits one `design_show` or `design_apply` call up to 6,000,000 bytes plus 64 KiB for its envelope. This covers a maximum 1,000,000-character document even when every character uses a six-byte JSON escape. Other tool calls and multi-call batches keep the 1 MiB limit. Oversized requests receive a bounded JSON-RPC error with HTTP 413; the server drains them without retaining the rest or destroying the socket. Tests create and replace maximum-size documents in raw UTF-8 and escaped JSON, and reject oversized fixed-length and chunked requests.

Comments remain readable and resolvable after their preview version is pruned. They retain their original version number and pin coordinates; new comments still require a retained preview. Completed design activity takes its title from the saved tool result. A confined phone receives Designs changes through its permitted Project socket. These follow-up checks passed 45 targeted tests.

Three component regression cases first reproduced silent layer loss: moving a layer into an instance, supplying ordinary children in a document or replacement, and converting a populated frame into an instance. All now reject the operation without changing the input. Follow-up cases reject missing, foreign and duplicate component source references, including replacements that reuse existing generated ids. Main-child deletion and reparenting still retire their previously valid copies. All 11 component checks pass. Component synchronization and document diffs reuse ancestry indexes. Instance paint order no longer performs repeated `indexOf` searches inside a filter.

Desktop and phone history keep the person's choice and comments as plain text when Designs is off or a preview is retired. Agent tool instructions stay hidden. Phone refreshes, reconnects and failed saves retain the last confirmed setting as stale instead of briefly hiding all designs. Project connections deliver setting changes directly. The updated mobile checks passed 211 tests and its typecheck; the runtime fingerprint stayed `d3dac4031e290045d21303d7735e75e033b14fb0`.

The desktop editor detects newer versions while open. Disjoint field edits can merge for review before saving; overlapping fields need explicit choices. Structural changes require a reviewed replacement, still protected by `expectedVersion`. Loading the latest version keeps the earlier draft and Undo history available to restore. Repeated arrow keys accumulate correctly before the preview reloads. Preview scripts now use an inline-only script policy.

The second Opus review found a clean-draft rollback case. The editor now adopts a buffered newer version after blur or Undo leaves it clean, and structural replacement requires an edited draft both in the interface and at execution. Pending saves remove the preview's editing controller so rejected arrow nudges cannot accumulate. Merge reviews exclude derived instance fields, display validation errors and preserve earlier recovery when the current document is clean. The updated Electron editor check covers these cases, and 13 contract/merge tests pass.

Final repository validation passed `npm run typecheck`, `npm run lint` and `npm test -- --unit`: 3,374 tests total, 3,363 passed and 11 skipped across 337 files. Lint reports warnings but no errors. An earlier run found duplicated IPC error parsing in the merge helper; it now uses the shared parser. An unrelated process-cancellation test failed once, passed its isolated rerun and passed the final full suite. Desktop editor and artifact Electron checks passed with screenshots outside the repository.

## Local rendering experiment

Printable ASCII now skips grapheme segmentation, and character advances are cached within each text-layout call. A comparison of 720 inputs preserved line breaks and dimensions across mixed scripts, emoji, accents, whitespace, narrow boxes and long text. HTML and SVG output matched byte for byte for both workloads below. Ten warm before/after samples alternated execution order on Node 24.13.0 / Apple M4 Pro; the table reports median preparation time.

| Workload                                  | Output |   Before |    After |
| ----------------------------------------- | ------ | -------: | -------: |
| 40 text layers, 132 characters each       | HTML   | 10.37 ms |  2.59 ms |
| 40 text layers, 132 characters each       | SVG    | 12.19 ms |  2.38 ms |
| 20,000 characters in a one-pixel text box | HTML   | 58.18 ms | 13.21 ms |
| 20,000 characters in a one-pixel text box | SVG    | 68.92 ms | 12.68 ms |

This experiment isolates text preparation; it excludes browser paint, provider latency and end-to-end generation. The machine was also running development tasks. Raw measurements are in `/tmp/milagre-design-perf-after-review.json`. Subsequent changes compute bounds once per HTML render and share text layout results between sizing and markup. Custom font metrics remain approximate; long clipped text can still produce large previews.

Native iOS verification covered the Experimental badge, review-only controls, remote OFF closing a review, ON restoring cards, preserved feedback with the flag off, and Settings state. The new switch's real runtime callback saved ON/OFF through host RPC. Direct automated switch taps remain unverified: the installed QA client also ignored taps on an unchanged SwiftUI switch. The preview remains available without a new native build or OTA release.

## Whole-page snapshot sharing

Sharing publishes the entire Designs page, with no individual design or element selection. Desktop and mobile show the public warning before publishing. History retains uncertain uploads so a lost acknowledgement does not hide a potentially public link. The host snapshots all current versions together, embeds supported remote images, and stores management capabilities privately. The design-only MCP adapter has no publication tool.

The final full unit run passed 3,401 tests with 11 skips and no failures across 342 files (67.6 seconds). Root typecheck, mobile typecheck and lint passed; lint retains existing warnings. A subsequent DNS-deadline regression and the snapshot/image checks passed all 11 focused tests. The added runtime and confined-phone checks passed 77 tests. Desktop artifact Electron checks covered publish confirmation, duplicate clicks, upload errors, uncertain publication history and revocation. Native iOS checks covered publish, copy, the native share sheet, revoke and Designs OFF. Android was not exercised. The mobile fingerprint remained `d3dac4031e290045d21303d7735e75e033b14fb0`; no native build or OTA was published.

The public viewer Electron check (`scripts/test-design-page-viewer.cjs`) verified raster pixels inside the SVG previews, CSP network refusal, escaped titles, desktop and phone gestures, pinch midpoint movement, and Fit with twenty maximum-width designs at a 320-pixel viewport. Desktop/viewer screenshots are in `/tmp/milagre-share-desktop`; native screenshots are in `/tmp/milagre-design-share-mobile`.

The Worker passed 15 service tests, its typecheck and lint. Actual local Wrangler/SQLite Durable Object checks covered create, identical retry, immutable content, revocation and permanent tombstones. Host integration also covered restart after a lost upload acknowledgement and cancellation before a delayed PUT. This was local synthetic content only. No Cloudflare deployment occurred. The retained local viewer URL and debugging port are recorded in `/tmp/milagre-design-page-preview.json`.

Review fixed an uncaught malformed image redirect, overly broad IPv6 filtering, uppercase HTTPS embedding, narrow-screen Fit and pinch panning. Opus 5.5 is reviewing the new sharing and scoped MCP adapter before a PR. The separate Local Milagre MCP Worktree still owns transport, grants and the design-only connection setup. Public launch also requires the ingress and abuse controls described in `apps/design-share/README.md`.

## Public-sharing review fixes

Opus 5.5's follow-up found no new blockers and confirmed the seven earlier fixes by reading the code. It did not run tests. The Worker now rejects text expansion above 50,000 characters before rendering or reserving quota, checks non-spending admission before reading the body, and streams public pages in 96 KiB chunks. Public GET/HEAD links accept tracking parameters. Rendered HTML is capped at 8 MiB.

The host checks service health before creating a capability, requires exact publish/revoke acknowledgements, strips hidden content and private layer metadata before image fetching, and rechecks MCP read authorization before returning data. Confined demo phones cannot publish or revoke. Desktop and mobile have a Published pages manager that retains revocation after Chat deletion. Both dialogs disclose that clipped vector content can remain in the shared file.

Two follow-up regression tests first failed, then passed: revocation while PUT is held open, and an unreadable history file preceding a valid one. Revokes now send DELETE outside the upload queue. Per-file read-modify-write locks preserve concurrent changes, including a revoked flag when a late PUT acknowledgement arrives. Unreadable histories are skipped with a warning. All 15 focused host sharing tests passed.

Final full verification passed 3,425 tests with 11 skips and no failures across 342 files (62.2 seconds). Root and mobile typechecks passed. Lint passed with warnings and no errors. Formatting and `git diff --check` passed for the follow-up changes.

Desktop artifact and Experimental settings Electron checks passed. Native iOS checks covered offline publishing, retry, global history and orphaned-page revocation. Screenshots are in `/tmp/milagre-share-review-desktop` and `/tmp/milagre-share-review-mobile`. Mobile fingerprint remains `d3dac4031e290045d21303d7735e75e033b14fb0`; Android was not exercised and no native build or OTA was published.

The Worker/shared focused checks passed 27 tests. Actual local Wrangler checks rejected the original 900,000-character repro with 413 and accepted a 50,000-character page. A host-to-local-Worker check published synthetic content, opened a tracking-parameter URL, deleted the synthetic Chat, and revoked through owner history. These checks establish behavior, not production Durable Object CPU cost. Production CPU measurement and the README's ingress/abuse controls remain deployment prerequisites. No Cloudflare deployment occurred.

## October 13 design review

The later Opus review did not cover the public Worker again. Its three local-tool defects were reproduced and fixed: HTML and SVG are limited to 8 MiB of UTF-8 output while being constructed, custom font names are quoted consistently, and inspector fields show the actual fill and stroke defaults. Rendered text omits lines below its visible content box, retaining partial lines and glyph overhang. The JSON source and layout measurements keep all text. A rejected render cannot create or advance a stored version. An oversized unsaved draft shows a recoverable preview error, with its inspector and Undo still available.

Individual browser font-load failures now use fallback fonts instead of aborting PNG export. Tests cover `Font 3`, `SF.Pro`, numeric-leading names, empty comma entries and invalid CSS syntax. Feedback hit testing maps generated children to their editable component instance. Confined demo phones cannot call `artifact:apply`. Resize respects locked ancestors, and Undo/Redo update the imperative document reference before another iframe event can arrive.

The combined desktop editor check passed, covering effective defaults, committing transparent fill and zero stroke width, quoted fonts in actual browser CSS and SVG, PNG export after a font-load rejection, locked-parent resize, immediate Undo/Redo events and recovery from oversized previews. The public viewer Electron check passed on desktop and phone viewport sizes. Native iOS on the attached Designs QA simulator rendered a host-generated document using `SF.Pro, Arial, sans-serif` and a 20,000-character one-pixel text layer. Its preview stayed at 9,045 bytes and the source retained all 20,000 characters. Mobile typecheck and 206 mobile UI harness tests passed. Android was not exercised; no native build or OTA was published. Screenshots are under `/tmp/milagre-inspector-review`, `/tmp/milagre-render-review` and `/tmp/milagre-font-mobile-review`.

A local measurement used 1,000 text layers, 325,948 bytes of source JSON, 789,296 bytes of HTML and 646,824 bytes of SVG. Seven runs after one warm-up measured medians of 56.28 ms for HTML, 39.51 ms for SVG and 6.47 ms for a single property edit. This measures synchronous preparation on the development machine while other work was running. It excludes iframe reload, image decoding, browser paint, IPC and provider latency and is not a before/after speed claim. Repeated validation, iframe reloads, sequential PNG image fetching, per-move snapping and operation-batch indexing remain performance follow-ups.

Remote Designs OFF now retains unsaved desktop work in a bounded renderer-session cache, without keeping Designs visible. Reopening offers Restore or Discard. Recovery includes the original saved base, draft, selection, Undo history and uncommitted field text; the existing conflict review handles newer saved versions. Successful Save and explicit Discard clear recovery. It is not crash or app-restart recovery. The cache holds at most five drafts and 16 MiB of estimated serialized content, trimming old Undo entries before eviction. Each unique history document is measured once during capture.

The final editor check passed in 18.9 seconds, including an actual parent unmount on OFF, pending text restoration without auto-commit, preserved edits/Undo, newer-version merge, successful Save cleanup and explicit discard cleanup. Two cache tests passed. Screenshot: `/tmp/milagre-inspector-review/design-editor-draft-kept-after-off.png`.

Final repository validation passed `npm run typecheck`, `npm run typecheck:mobile`, `npm run lint` and `npm test -- --unit`: 3,447 total tests, 3,436 passed and 11 skipped across 345 files (73.7 seconds). One preceding full run timed out in the unchanged `computers-e2e.test.cjs` routing check at `computers:invoke`. All five tests in that file passed in isolation, and the subsequent full run passed. No assertion or timeout was weakened. Formatting and `git diff --check` passed.

## Floating desktop tools and real Chat run

The desktop editor now has a floating tool rail and an optional Layers panel, closed by default. Parent layers can collapse without losing selection. Escape closes Layers before the editor, including when pressed inside the preview. Arrow-key navigation in the rail does not move selected layers. This changes the desktop editor only; mobile remains review-only as requested.

The editor Electron check passed in 25.4 seconds, including the new panel, collapse, focus and keyboard checks and the existing editing, recovery and export checks. The full desktop renderer was rebuilt and opened in an isolated app profile with a real empty Git Project, the normal daemon and a signed-in Codex provider. No Chat, transcript or design was seeded. A request sent through the Chat composer created Fieldnotes as an editable 56-layer design at version 1. Its first tool call failed because a rectangle had children; the provider corrected it to a frame and successfully retried.

The rebuilt editor was opened from that Chat's design card and visually checked. The live app retains the conversation and generated document for manual testing. Screenshot: `/tmp/milagre-design-real-chat/floating-tools.png`. The editor uses Milagre's own structured document engine, not an embedded OpenPencil editor. No production service, release or public snapshot was deployed for this run.

## Whole-page editor and compact sharing

Edit now opens a full desktop page containing every structured design in the Chat. Each artboard stays mounted while the shared Layers panel and inspector switch between them. Drafts, Undo history and version-conflict recovery remain attached to their designs. Save processes every changed design; a conflict selects the affected design and retains remaining drafts. These are still separate version writes, not an atomic page transaction. Closing checks all drafts, including inactive artboards.

The top-right pill contains Undo/Redo icons, Share, Export, Save and Back to Milagre. Export opens a format dialog and includes the whole page's current drafts: one composed PNG or SVG, or a JSON page containing every source document. Pending inspector input is committed before switching artboards, saving or exporting. The Electron check covers two artboards, draft retention, saving both, export contents and dimensions, unique SVG fragment ids, and discard across inactive drafts. Mobile remains review-only as requested.

The actual packaged renderer exposed a selection failure that the development fixture missed: its CSP blocked the generated inline controller. The controller and Escape listener now use stable bundled scripts with exact CSP hashes, with document data in inert JSON. A production-CSP Electron regression passed native pointer selection and Escape while rejecting unapproved inline scripts. The controller generator has a unit check against its checked-in output.

The compact snapshot dialog was updated on desktop and mobile. Initial publication, confirmed links, copy, revocation and collapsed history retain the public-access warning, frozen-page scope, uncertain-upload recovery and global management after Chat deletion. Share entry points now stay hidden until the host confirms that publishing is available. Failed health checks, older hosts and confined phones do not show Share. Desktop review and editing share one status per host; foreground/reconnect checks and newer dialog results refresh that state. Settings retains Published pages management even when publishing is unavailable.

Root typecheck and lint passed, with lint warnings but no errors. Before the entry-button follow-up, the full unit run passed 3,437 tests with 11 skips and no failures across 345 files (3,448 total). The updated desktop artifact check passed in 42.8 seconds, including hidden Share during the initial check, unavailable service, recovery and a failure after opening the dialog. The final editor check passed in 27.0 seconds, including an older host with no sharing endpoint. Mobile typecheck, scoped lint and 207 UI checks passed. Native iOS verified unavailable and healthy entry states and hiding Share after a failed dialog check; Android was not exercised. The mobile runtime fingerprint remains `d3dac4031e290045d21303d7735e75e033b14fb0`; no native build or OTA was published.

The real desktop Chat also created Fieldnotes Evening through the normal signed-in Codex provider and a reviewed `design_show` approval. It has 48 editable layers at version 1; the original 56-layer Fieldnotes remains at version 1. Opening Edit loaded both on one full-page canvas under the packaged CSP. Native pointer clicks selected each headline and updated the shared inspector. The actual unavailable service hid Share in both the review canvas and editor. Export opened its format dialog; both saved documents remained unchanged. No Chat, message or design was seeded for this run. Screenshots: `/tmp/milagre-design-real-chat/whole-page-ready.png` and `/tmp/milagre-design-real-chat/whole-page-export.png`. The public Cloudflare Worker remains undeployed; public sharing is unavailable, while local editing and exports work.

## Final whole-page review regressions

The independent Codex review found two blockers and a desktop sharing gap. Opus's final whole-page attempt hit its session limit and supplied no findings; it is not a sign-off. The findings were checked against the current source before fixing them.

PNG export now draws each SVG into the scaled intermediate canvas dimensions. The real Electron export check composes two 2500 by 1000 artboards into a 4096-pixel page and asserts magenta pixels at the right and bottom edges of both artboards. The retained draft from Load latest now belongs to the bounded renderer-session cache, including its saved base and Undo history. The editor check restores it after both a clean Close and remote Designs OFF/ON. Cache unit coverage checks byte limits, history trimming and non-mutation. Desktop Share exposes uncertain-publication history on reopening and keeps it open after revocation, matching mobile's visible warnings.

After these fixes, root and mobile typechecks, lint, the production build and the sharing Worker typecheck passed. The full unit suite passed 3,439 tests with 11 skips and no failures across 345 files. The updated editor Electron check passed in 25.2 seconds; the artifact check passed in 31.4 seconds after correcting its new reopen selector and keeping resolved history expanded. Screenshots are in /tmp/milagre-pr-design-fixes. These checks use isolated fixture state; the earlier real-provider Chat verification remains separate evidence.

Large-page panning performance remains unprofiled. Android was not exercised. Public sharing still requires deployment and the launch controls documented in apps/design-share/README.md.
