# Baseline: 2026-10-31

Nine requests, two independent generations each, Claude Opus 5.5 via Claude Code 2.1.316. Only the real `html_preview` and `html_render` tools were available; no additional skill or evaluator expectations were supplied. The system prompt, tool guide and renderer stayed unchanged during generation.

Generation completed 18/18, with 49 tool calls, no timeouts, and $2.9331 of reported model usage. All published sources match their persisted bytes. These are generation results, not a claim that all visuals passed.

The retained baseline is `~/.milagre/evals/html-inline-20261031-v2` (original run: `/tmp/milagre-html-eval-baseline-20261031-v2`). Its manifest, source snapshots, original HTML, tool trail, 72 independent screenshots and reviewer evidence are retained separately from this checkout. The live fixture serves its gallery at `/report.html`; see README commands to restart it. Review scores are judgments by subagents, not human ratings.

## Findings to prioritize

| Finding                                              | Evidence and attribution                                                                                                                                   | Next experiment                                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Table values become unreachable at narrow chat width | `orders-table-r2`, `qa-desktop-b/orders-table-r2-scrollfix-*.png`. Nonwrapping generated cells exceed the available width; no usable horizontal container. | Replay the same HTML with a table containment fallback. Also evaluate at the actual transcript content width, not just a standalone375px page. |
| Touch controls are small                             | Native checklist/sine samples and shared styles: checkbox15px, range22px, coarse-pointer buttons36px.                                                      | Improve shared touch defaults, then replay identical HTML on desktop and native mobile.                                                        |
| Graph labels need close reading                      | Repeated chart/timeline findings; frozen guide explicitly prescribes11–12px labels.                                                                        | Later prompt experiment: readable chart labels and explicit hierarchy. Do not call this model disobedience.                                    |
| Alternative approval paths are difficult to read     | Both approval repeats use low opacity on inactive branches.                                                                                                | Later prompt experiment: retain readable inactive context.                                                                                     |
| Exact numeric selection is cumbersome                | Both calculators use slider-only input; approval r1 uses R$50 steps.                                                                                       | Later prompt experiment: pair precision-sensitive sliders with numeric input or step controls.                                                 |
| Final-source preview coverage is weak                | Only1/18 validated the final HTML at both375/720 before publication;9/18 validated it at any size,2/18 in dark.                                            | Validate exact-source hashes and actual content widths in tooling. Do not count previews of earlier versions or placeholders.                  |

The full four-way width/theme matrix was independently captured for every output. None of the18 model sessions completed that full matrix for the final source before publication. The current guide does not explicitly require all four combinations; this is a QA coverage gap, not by itself an instruction violation.

## Interpretation and limits

Three reviewers split the18 outputs and exercised their applicable interactions. Each output has one reviewer; the same persona reviewed both repetitions of a case and some findings repeat verbatim. There is no independent overlap or inter-reviewer agreement measurement. A separate native pass samples three first repetitions: expandable checklist, sine explorer and compact empty state. Narrow Chromium captures use a13px base while native text is around17px: fixed12px labels are proportionally smaller on the phone. They do not substitute for native coverage of all18. Slow-network behavior of the production app is not established by Vite fixture loading; iOS throttling was unavailable.

Fixture defects were found and corrected during review: missing theme-change event, missing mobile viewport metadata, and missing app scroll container. Affected checks were rerun; these are excluded from product failures. The initial authless18-session attempt made no tool calls and reported no model cost. A second attempt was interrupted after starting three sessions; it has no complete usage result. Both are preserved as infrastructure attempts, separate from the completed baseline. The reported$2.9331 covers the completed run only.

No generated HTML was repaired, and no product renderer or prompt was changed for this baseline. For renderer work, reuse these exact HTML sources; for prompt work, make new independent generations with the same corpus/model and a new output directory. Two repeats characterize observed variation, not a reliable population failure rate or a comparison against T3.

## Reviewer score distribution

Scores are0–4, with4 meaning no observed issue in the examined states. They are subjective reviewer judgments with linked evidence, not calibrated model benchmarks.

| Dimension           | Distribution                                         |
| ------------------- | ---------------------------------------------------- |
| Content correctness | 18 scored4                                           |
| Legibility          | 2 scored2;14 scored3;2 scored4                       |
| Responsiveness      | 1 scored1;1 scored3;16 scored4                       |
| Interaction         | 11 scored3;3 scored4;4 static outputs not applicable |
| Chat integration    | 1 scored2;17 scored4                                 |

The table's calculations are correct even though its narrow rendering fails. Keep that render failure visible instead of averaging it away.

Native evidence: `qa-native/native-review.json` and eight screenshots. All three sampled r1 cases passed tested logic, expansion/shrink, scrolling and live theme preservation. Small touch targets remain open.

Validation of the eval infrastructure: typecheck passed; repository lint passed with existing warnings outside this eval; six focused tests passed. No full repository unit-suite run was needed for these standalone evaluation scripts. No commit, PR, deployment or native build was made.

## Fable review and decision

The only observed major defect, `orders-table-r2`, had previewed the exact final source at375px. Its table is about375.43px wide, while the actual narrow transcript offers about343px before scrollbar differences. The body clips the overflow. Missing preview counts do not explain this defect and do not justify stricter prompting by themselves.

Before the PR, change the renderer to contain overflowing tables with their own horizontal scroll, add textual overflow diagnostics to `html_preview`, and correct the documented narrow content width to340px in the tools and bundled skill. Replay the immutable sources with this renderer; keep the original baseline and scores unchanged. Future eval manifests freeze340px for the narrow inspection; historical manifests continue at375px.

Do not rewrite the design guidance from this sample. Test relative chart labels (`.85em` instead of11–12px) in a later controlled A/B before adopting it. Checkbox/range touch sizes remain a minor follow-up; inactive opacity and slider precision remain hypotheses based on two repeats of one case each. The36px coarse-pointer button default matches the app's own pills.

## Renderer replay after review

Replayed all 18 immutable final sources through the corrected renderer, in a separate output directory. All 72 inspection captures completed without console errors. The 36 wide captures (720px, light/dark) are pixel-identical to the original baseline. This establishes no visual difference in those captured states, not general absence of regressions.

Desktop replay of the overflowing table at343px and native iPhone replay confirmed horizontal access to the last column, vertical transcript scrolling, sorting, filters and state preservation on theme changes. Minor touch-target findings remain open. Baseline scores have not been relabeled or averaged away; replay evidence is separate.

A subsequent real-provider desktop check with Codex found preview screenshots being published as image steps above the final HTML. The generation-only eval did not cover that provider-to-transcript integration path. The provider now suppresses `html_preview` images from transcript steps while retaining them in the model's tool response. Provider regression tests and a fresh real-app Codex Chat confirmed five previews produced zero image steps and one final HTML reply. This smoke check is separate from the frozen Claude eval. The real calls also retried an empty title, so the tool schema now clarifies that its required title is an internal label, not a visible heading.
