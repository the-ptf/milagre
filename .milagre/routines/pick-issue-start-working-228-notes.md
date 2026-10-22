# Issue #228: non-mutating reverse reads

Scope: complete the `unicorn/no-array-reverse` rule, one rule per PR as the issue requests. Leave #228 open for the other rules. The original routine prompt already exists and stays unchanged.

1. Record the 23 existing rule warnings and inspect desktop, mobile and shared consumers.
2. Replace copy/reverse/find with the existing `findLast` pattern; use `toReversed` for full reverse reads. Keep intentional in-place reversals. Promote the rule to error without suppressions.
3. Run the real desktop dev app and installed mobile development client against an isolated Project/profile with real providers. Exercise live activity, completed replies, empty state and repeated reads. Capture unedited PR screenshots outside the checkout.
4. Run root typecheck, lint, unit checks, mobile typecheck, relevant Electron checks and compare mobile fingerprints. Get an independent correctness review and open a PR with evidence.

Ruling: no new tests that mirror mechanical replacements. Existing behavioral checks plus direct runtime interaction establish ordering and input preservation. No native changes, releases or artifacts are authorized.

Proposed routine improvements: measure the current lint baseline instead of trusting old issue counts; use one rule per PR when the issue asks for that split; verify both runtimes for modern array methods. Use `test-milagre-app`, `test-milagre-mobile`, `verification-before-completion`, Milagre Tasks, Argent and `gh`. Existing MCPs suffice. Keep evidence in the PR and never publish an artifact or public report link.

Verification notes: the desktop renderer needed ES2023 ambient libraries for the array methods; its ES2022 JavaScript target stays unchanged. The first full unit run had four timeout failures under default parallelism; all four files passed sequentially (73 tests). Re-run the complete suite with bounded concurrency. A cloned simulator needed `simslim repair-clone` before slimming could finish; verify the exact profile before installation. Native fingerprint before/after matches TestFlight (`f4e06634227845fd1879a6569989ac2bfe11e693`).

Final verification: 5,249 unit tests passed, 12 skipped, zero failed across all 447 files with `env -u ELECTRON_RUN_AS_NODE node --test --test-concurrency=4` using the runner's file list. The prescribed `npm test -- --unit` was also run; default concurrency reproduced a peer-usage timeout that passes in isolation. One earlier bounded run encountered a Node test-runner deserialization error; `monorepo.test.cjs` passed separately and the clean-environment full run passed. Root/mobile typechecks, root/mobile lint, formatting, and Electron Subagents, Routines, reply-thought, chat-layout and test-desktop checks passed. Independent final review: no code findings.

Real runtime evidence: isolated desktop dev app and installed iOS development client on iPhone 17 Pro/iOS 27 against Metro in this Worktree, real GPT-6.1-Sol Chat. Verified empty Chat, README read and local command approvals, newest running activity, completed reply, activity expansion, reconnect/relaunch and retained model. Checked empty/frozen/multiple-match arrays in Node, V8 and Hermes without changing inputs. iOS native automation needed a simulator reboot after its accessibility reader stalled on the sheet. Android was not run. No native build or OTA was started. Screenshots remain outside the PR commits and follow the screenshots-branch convention. No Artifact or public report was created.

# Issue #228: event listener rule

The original prompt remains in `pick-issue-start-working.md`.

1. Read the issue body with `gh issue view --json title,body,comments`. `--comments` alone can omit the body. Check open PRs before choosing one rule from a tracking issue; reference the tracker without closing its remaining work.
2. Run the selected lint rule as an error before editing to inventory every current occurrence. For event listeners, inspect retry lifetime, shared DOM elements, property aliases and test event sources before converting assignments.
3. Use a skeptical cross-platform reviewer for lifecycle decisions. GPT-6 Astra identified the reused simulator video element and recommended attempt-scoped listener cleanup. Only name models that ran.
4. Reuse `test-milagre-app`, `test-milagre-mobile`, `systematic-debugging` and `verification-before-completion`. The installed `gh`, Milagre simulator tools and Argent are sufficient; no new MCP is needed. Confirm the existing mobile runtime before editing, keep builds and publication outside this task, and run the changed app locally. If the full suite times out under machine load, retry all files with a bounded worker count and report both results; never increase test deadlines to hide a failure.
5. Keep screenshot evidence in the PR. Never follow earlier notes that recommend publishing an Artifact or public review page; those conflict with this routine's explicit no-public-link instruction.
