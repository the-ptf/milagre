# HTML generation eval

This evaluates the HTML an actual model produces through Milagre's `html_preview` and `html_render` tools. It preserves the published HTML, then independently captures it and records reviewer judgments. Read [RUBRIC.md](RUBRIC.md) before grading.

The baseline has nine requests and two independent generations per request. Only each case's `prompt` goes to the model; `expected` and `interactions` belong to evaluators. The instructions are frozen for a run. Generation, rendering and instruction compliance have separate results: successful tool calls are not a visual-quality pass.

## Run

Requirements: the checkout's installed dependencies, installed Chrome for the real preview tool, and a signed-in Claude Code CLI. No native build is required. **Generation makes real model calls and may incur charges.** The default cap is $2 per session; 18 sessions therefore have a $36 configured maximum, not an expected bill. Actual reported cost is recorded. Inspection makes browser calls only.

```sh
# Validate the plan without model calls or output creation.
node scripts/html-eval/run.cjs --out /tmp/html-eval-baseline --dry-run

# New output directory, 18 generations, no more than three at once.
node scripts/html-eval/run.cjs --out /tmp/html-eval-baseline --repeat 2 --concurrency 3

# Inspect every final output at 720/340 px (historical manifests without previewNarrowWidth retain 375), light/dark; retain failed sessions.
node scripts/html-eval/inspect.cjs --out /tmp/html-eval-baseline
```

`run.cjs --help` lists model, CLI, timeout, budget, prompt-file and case-filter overrides. For a small run, use `--case monthly-cost --repeat 1`. Output must be outside the checkout and must not already exist. The runner saves the model, case corpus, system prompt, instruction/renderer source hashes, timestamps, tool calls, original HTML and responses. Sessions use isolated working directories with only the two HTML tools, no extra skills, CLAUDE.md or memory. A timeout or failed generation remains a failed session, rather than being silently retried.

## Evidence and review

- `manifest.json` and `snapshot/`: the frozen run configuration and sources.
- `summary.json`: generation results and reported cost. The inspector does not overwrite it.
- `sessions/`: model trail, original requests, HTML, previews and CLI result.
- `inspection/`: independent screenshots of the final HTML. These were not seen by the model during generation.
- `index.json`: per-session evidence, errors, exact final-source hash and preview coverage.
- `inspection-summary.json`: counts, not visual grades.
- `report.html`: offline screenshot gallery with source text links. Generated HTML/scripts never execute inside the gallery. Keep its neighboring files when moving the report.
- `report.md`: textual findings; `reviews.example.json`: an ungraded template.

The final-preview compliance check requires a successful preview of the **same HTML hash** to finish before the final render starts. A preview started in parallel, an earlier revision, or a placeholder does not count. Missing timestamp evidence does not pass. The manifest freezes the narrow QA width: new runs use340/720; historical manifests retain375/720. Any dark preview and the full four-combination QA matrix are reported separately. The current tool guide asks for340/720 and dark when colors matter; it does not explicitly require all four combinations. Missing a QA combination alone is not instruction disobedience.

Reviewers inspect screenshots and exercise the case's interactions in an isolated app/browser instance. Copy relevant entries from `reviews.example.json` into `reviews.json`, replace placeholder reviewer/evidence, grade each dimension 0–4 or `null` for untested, and add findings. Keep `htmlSha256`: a review for a different final HTML is treated as stale. A review entry looks like:

```json
{
  "version": 1,
  "sessions": {
    "monthly-cost-r1": {
      "reviewer": "qa-mobile",
      "htmlSha256": "COPY_THE_EXACT_FINAL_HASH",
      "evidence": ["qa-mobile/cost-21.png", "qa-mobile/interactions.md"],
      "scores": {
        "correctness": 4,
        "legibility": 2,
        "responsiveness": 3,
        "interaction": 2,
        "integration": 3
      },
      "findings": [
        {
          "attribution": "generated-html",
          "description": "No way to enter an exact count beside the slider.",
          "evidence": "qa-mobile/cost-21.png"
        }
      ]
    }
  }
}
```

Allowed attribution: `renderer`, `generated-html`, `instructions`, `harness`, `unknown`. Cite evidence for each finding; use `unknown` until root cause is confirmed. Don't infer correct interactions from source code or screenshots alone. Rebuild reports without rendering or model calls:

```sh
node scripts/html-eval/inspect.cjs --out /tmp/html-eval-baseline --report-only
```

An unreviewed output stays **UNREVIEWED** even if it has no console errors. Console output and height are diagnostics, not automatic failure thresholds. Initial height hints may differ from measured final height because the renderer resizes. Whole-page overflow, clipped data and broken controls require direct evidence. A 375 px Chromium screenshot is a narrow-web check, **not native mobile QA**; validate representative cases in the actual mobile app and record device, theme, interactions and any network-testing limits separately.

## Compare changes

Keep generated HTML unchanged when investigating renderer defects: replay the same source on baseline and changed renderer, record their hashes and collect fresh screenshots separately. To evaluate a changed prompt, start a fresh generation run with the same cases, model, repeats and tool settings, using a different `--out`. Compare paired cases and their variation, never overwrite the baseline or repair its outputs. Pin model versions when available and record the actual response model.

The baseline alone does not prove the instructions improve quality, and two repetitions are not a reliable population success-rate estimate. Inspect regressions as well as average grades. Separate renderer changes from prompt changes so their effects remain interpretable. Fixture screenshots are test evidence, not PR screenshots from real-provider app usage.

## App wrappers for interaction QA

After inspection creates index.json, serve the preserved sources in the actual desktop reply component:

```sh
node scripts/html-eval/serve.cjs --out /tmp/html-eval-baseline --port 5191
```

Open `http://192.168.2.210:5191/?session=monthly-cost-r1` on this machine/network, or `/report.html` for the gallery. Use the host's current address on another machine. The server binds0.0.0.0. Each reviewer needs an isolated browser/profile. The fixture replaces the data bridge, not the reply component; fixture navigation is not part of the model output. Vite development-module loading can distort slow-network startup measurements: identify that as a harness limit.

For native sampling with an existing dev app and an already verified/attached simulator:

```sh
node scripts/html-eval/mobile.cjs --out /tmp/html-eval-baseline --port 8897 --case expandable-checklist,sine-explorer,compact-empty-state
```

This starts a disposable demo daemon and Metro8790, loads the first repetition of each selected case, and writes `mobile-state.json`. It does not build or install native code. Follow the repository's simslim and simulator-attachment rules, and keep each device exclusive to one reviewer. The native app still uses a demo data bridge; record this when reporting evidence. Stop only processes owned by this evaluation after reviewing.
