# HTML inline eval

This corpus measures whether independently generated replies are correct and usable in Milagre. It is a baseline for renderer improvements first, and later prompt experiments. Keep generated HTML immutable. Do not repair examples before scoring them.

## Run design

- `cases.json` contains nine natural user requests. The first three retain the earlier exploratory prompts. Run each twice in fresh, isolated model sessions: 18 outputs, not 18 distinct tasks.
- Send only `prompt` to the model. `expected` and `interactions` are evaluator material, never generation context. A case with no request for controls can pass as a static visual.
- Freeze model, system prompt, tool descriptions/schemas, renderer source, CLI version and corpus for a run; record hashes and Git revision plus dirty-file hashes. Record run settings and actual response model, not just the requested model.
- Model tools are the checkout's real `html_preview` and `html_render`. Use separate empty working directories and artifact stores; no extra design skill, project instructions or evaluator feedback enters generation.
- Record every tool call, its HTML hash, timing, errors, console output and screenshot. Record final source, publication success, persistence equality, model-reported cost and duration. Keep auth configs private and outside committed evidence.
- Inspector captures are separate from model previews. The inspector cannot retrospectively give the model credit for a preview it skipped.

## Surfaces and evidence

For each final HTML, inspect 720px and 375px in light and dark. Record the actual available content width: a 375px browser with transcript padding does not have 375px of HTML space. Browser emulation is not native mobile verification.

Drive the interactions in the case, starting from initial state. Capture before/after for important changes, especially dynamic height, empty state and theme changes. A screenshot proves appearance at one moment; it does not prove controls work. DOM measurements can flag overflow, small text and touch targets but do not replace visual inspection. Confined, usable horizontal scrolling inside the dense table is acceptable; whole-reply horizontal scrolling is not.

Check both app wrappers where available, using isolated instances. Record native device, theme, viewport, touch input and throttling availability. Mark native checks `untested` if only Chromium was examined. Never infer native pass from the shared renderer. Fixture screenshots are test evidence, not PR screenshots from a real provider conversation.

Reviewers should not edit outputs or see another reviewer's scores before submitting. Code/source inspection for attribution happens after the visual judgement. Keep factual disagreements and their resolution visible. A reviewed screenshot set can receive visual scores; unperformed interactions must remain untested.

## Scoring

Use integer scores **0–4** for each dimension, with `null` plus an explanation for untested dimensions. Each score needs evidence paths and a short observation. Apply the common anchors consistently:

| Score | Anchor                                                                          |
| ----- | ------------------------------------------------------------------------------- |
| 0     | Core task fails or the visual is unusable.                                      |
| 1     | Major defects block a necessary part; a workaround is insufficient.             |
| 2     | Task can be completed, with noticeable friction or several minor defects.       |
| 3     | Task works with at most minor friction; no major defect.                        |
| 4     | Clear, complete and usable across the examined states, with no observed defect. |

| Dimension        | What to examine                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `correctness`    | Requested facts, quantities, units, labels, formulas and paths match `expected`. Do not infer missing data from a plausible chart.                                                                                                                           |
| `legibility`     | Text, chart marks, legends, selected/inactive states and contrast are readable in both themes. Check collisions and truncation. Text below14px on mobile is a flag to inspect, not an automatic factual failure.                                             |
| `responsiveness` | Narrow and wide layouts keep content and controls accessible. Long labels, table columns and charts remain interpretable. Dynamic growth/shrinkage and resizing do not clip content.                                                                         |
| `interaction`    | Requested controls work, expose state and preserve valid values. Test limits, repeated actions, keyboard and touch where applicable. A target under44px/pt or a precision-only slider is a usability flag. Static cases may be `null` with `not-applicable`. |
| `integration`    | Reply sits naturally in the Chat: no unwanted outer shell, duplicated heading, initial top gap, opaque rectangle, nested scroll trap, stale height or lost state on theme change. Content cards or flow nodes serving the requested visual are allowed.      |

Do not compute a single reassuring average that hides failures. Report dimension distributions, hard failures and examined/untested counts. If showing a total, label it descriptive, include coverage and exclude null dimensions from its denominator. Report both repeats, the worst repeat and the difference; do not select only the better one.

## Hard gates

Each gate is `pass`, `fail` or `untested` with evidence. A gate fails when the defect prevents the requested task or conveys materially incorrect information; small cosmetic flaws belong in scores.

- `publication`: final HTML was successfully stored and matches the published source.
- `content`: essential values, formulas, relationships and required content are correct.
- `render`: content is visible and not materially clipped or covered in tested states.
- `controls`: required interactions respond and maintain correct state; mark not-applicable in notes when the case is static.
- `containment`: response remains usable within the Chat, including scrolling and dynamic sizing.

A run can succeed technically while failing content, visual or interaction criteria. Missing evidence is never a pass. Failed generation remains in the denominator, even if a later retry succeeds; log retries as additional attempts.

## Instruction adherence is separate

Record successful previews before publication whose HTML hash equals the final HTML. Report width375, width720, any dark preview and full four-combination coverage separately. Also record whether the model changed HTML after the last successful preview and whether a preview used placeholder content.

The current tool description requests375 and720, plus dark when colors matter. It does **not** explicitly demand all four Cartesian combinations. Full-matrix inspection is an eval requirement; missing a combination alone is not proof of instruction disobedience. The current guide explicitly requests chart labels at11–12px, so small-label complaints may identify a prompt problem even when the model followed instructions. Neither compliance nor preview count proves visual quality.

## Attribute only with evidence

Each finding records: case/repeat, surface/state, severity (`blocker`, `major`, `minor`), observation, expected behaviour, evidence paths, category, confidence (`confirmed`, `suspected`) and rationale.

| Category         | Evidence required                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderer`       | Shared shell or platform wrapper causes the problem with otherwise valid source; show the same HTML under comparison or trace the wrapper behaviour.                                               |
| `generated-html` | Source encodes incorrect data, inaccessible controls, layout or state; reproduce it in the final rendered output.                                                                                  |
| `instructions`   | Frozen guidance explicitly encourages the poor result, is contradictory, or demonstrably omits a repeated requirement. A model ignoring clear guidance is not automatically an instruction defect. |
| `harness`        | Fault originates in fixture loading, browser setup, data bridge, evaluator assumptions or capture timing. Keep separate from product failure.                                                      |
| `unknown`        | Evidence does not yet distinguish causes; do not guess.                                                                                                                                            |

Several symptoms can share one cause. Deduplicate only after confirming that cause. Rank findings by affected cases and repeats, then severity and surfaces; count independent reviewers separately from occurrences. List proposed renderer fixes separately from prompt hypotheses. This first baseline does not change either.

## Comparing later runs

For a renderer change, replay the **same immutable HTML outputs** through old/new renderers, then rerun generation separately if desired. That isolates rendering effects. For a prompt change, keep renderer/model/corpus fixed and generate fresh independent samples under each prompt. More than two repetitions will be needed for reliable rate estimates. Do not claim causal prompt gains from this baseline alone or equivalence to T3 without a matched comparison. Preserve case/version changes and missing coverage in every report.
