# Local desktop measurements

This collector reads existing processes and installed bundles. It never launches, quits or restarts an app/host, moves the user's UI, sends a Chat, starts an agent turn, clears caches or modifies application data. It adds no dependencies. macOS only.

```sh
node experiments/rust-desktop/perf/collect.mjs \
  --samples 11 --interval-ms 1000 \
  --output /tmp/milagre-performance.json
node --test experiments/rust-desktop/perf/metrics.test.mjs
```

The output is JSON for the final phone-viewable comparison artifact. Keep measurements outside the repository: executable paths and process IDs refer to this computer. The file is created with mode `0600`. The collector records OS version, chip, model, memory and CPU core counts, but no serial number, hostname, environment variables, process arguments, Chat content or credentials.

## Attribution

The installed app's `Info.plist` supplies its executable path. A unique running match identifies each shell; ambiguity/missing processes are `unmeasured`, never guessed. Override with `--electron-pid PID` or `--rust-pid PID`; the collector checks the supplied PID matches that app's executable. App paths can be changed with `--electron-app PATH` and `--rust-app PATH`.

A read-only `daemon:status` request to the current user's existing private socket identifies the shared daemon's PID. Override the profile with `--profile PATH` or the PID with `--daemon-pid PID`. No daemon is started. If the daemon cannot be identified, the Electron process tree is explicitly marked potentially contaminated by shared work.

Four separate groups are reported:

1. `electronShell`: Electron's root and descendants, excluding the shared daemon subtree and Rust subtree.
2. `rustShell`: Rust's root and descendants. This generally excludes its launchd-owned WebKit services.
3. `sharedDaemon`: the existing Node host process, counted once, separately.
4. `sharedDaemonChildren`: host-owned agents, tools and other children. The Rust app may itself have been launched by such an agent; its subtree is excluded here.

The collector and its `ps` subprocesses are excluded. A sampling orchestrator can also exclude its own process and descendants with `--observer-pid PID`; those IDs are recorded in the report. `paired-observation.mjs` does this for itself. Never use this flag to hide application work. No unassociated WebKit process is attributed to Rust based on timing, process name or a memory change. If macOS exposes a verified responsible-process relationship through an independent tool, supply that exact PID with `--rust-helper-pid PID` (repeatable) and `--helper-evidence 'How ownership was established'`. The same applies to `--electron-helper-pid`. This is operator-supplied evidence, not independent verification by this script. Recheck PIDs after app restarts. Supplying one helper does not prove all rendering, GPU and networking services were identified; the full Rust footprint stays explicitly unmeasured.

`identify-webkit.mjs --rust-pid PID --output /tmp/milagre-webkit-identities.json` gathers targeted LaunchServices evidence for the installed `com.milagre.rust-poc` app and its exact `Milagre_Rust_Web_Content`, `Milagre_Rust_Graphics_and_Media` and `Milagre_Rust_Networking` service identities. Only a single matching Rust root yields suggested helper PIDs. Review that JSON, then supply its IDs and evidence path to the collector. This is app-label evidence, not direct IPC ownership proof. The OS responsibility API can name the Electron agent that originally launched Rust as responsible for both Rust and its helpers; that result alone cannot distinguish Rust's services.

## Metrics and limits

- `rssKiB`: sampled resident pages from `ps`. Sums may double-count shared pages. This is not physical footprint, PSS, unique memory, allocated heap, compressed memory or GPU memory. No total-memory reduction is calculated.
- `cpuPercentOfOneCore`: difference in cumulative process CPU time over the sample interval.100% means one fully occupied core; values can exceed 100%. This is not `ps`'s lifetime averaged `%CPU`. The first interval, changed process membership and decreasing counters are unmeasured. The CPU counter's 0.01-second precision makes very short intervals noisy.
- Bundle `allocatedKiB`: `du -sk` of the installed app. This includes source maps or other files present in that install. It is not compressed download size, final release size or runtime memory.
- Each measured series has sample count, median, minimum and maximum. Raw per-process samples retain parent PID, executable, process start time and cumulative CPU time so attribution can be audited. PID reuse does not silently join CPU intervals.
- Startup, scroll frame times, interaction latency, streaming latency and total physical footprint are unmeasured by default. The current shared Node daemon is not an all-Rust backend comparison.

Do not put `electronShell` and `rustShell` RSS into a chart labeled "total app memory": Rust's WebKit services are typically missing from that group. Do not combine the daemon into both app totals. Present unmatched observations as diagnostics, with attribution limits beside every figure.

## Same-workload comparison protocol

Run this protocol only after the app's core functionality and saved-data compatibility pass. Arrange the two UIs manually or with a separately authorized UI driver; the collector itself does not do so.

1. Record exact installed versions/commit IDs, build mode (release), launch mode, visibility, display scale, window size, theme, motion settings, font scale and open windows. Both applications must be equally visible or equally backgrounded. Native WebKit hides/pauses work differently from Chromium; a hidden Rust window versus actively used Electron is not a comparison.
2. Use the same local Project, Chat, transcript page count, scroll position and panel state. Match Designs/Artifacts/terminal contents where that scenario exercises them. Close optional surfaces in both applications if excluded. Verify both show the same state before recording.
3. Use the same already-running daemon and keep provider/agent activity constant. For idle measurements, wait for background turns/tool work to finish and warm both UIs for 30 seconds. Record shared daemon/agent costs separately. Avoid a concurrent build, test suite or disk-heavy task.
4. Collect at least 11 samples at 1000 ms and repeat the entire scenario at least 5 times. Alternate measurement order, report per-run medians plus all-run ranges, and preserve the raw JSON. Record shell process counts and any PID churn. For a controlled active scenario, apply the same scroll/interaction trace and separately record frame/latency timings; this collector alone cannot produce FPS or interaction latency.
5. Only then pass `--matched-workload --workload-description 'Exact scenario and matching controls'`. That flag records an operator attestation; the script does not verify visual equivalence and still computes no speedup ratio. Capture screenshots and attach the environment/scenario description beside results.

Start with idle Chat, long transcript, saved Design canvas, saved HTML Artifact and existing terminal-view scenarios. Add a provider streaming scenario only when separately authorized; never start paid work to fill a benchmark chart by default.

## Optional startup observations

A startup benchmark needs an independent timer whose endpoint is the first usable Chat (data and composer ready), not process spawn or first window paint. Record app process start, first frame and first usable Chat separately when instrumentation supports them. Use at least 5 observations per app/condition. Define "cold" and "warm" explicitly in each method: process-cold and OS-cache-cold are different, and this collector does not flush caches or reboot the Mac.

Supply a JSON array with `--startup-observations /tmp/startup.json`:

```json
[
  {
    "app": "rust",
    "kind": "warm",
    "milliseconds": 1234,
    "method": "Example schema only: replace with independently measured launch-to-usable-Chat timing; record build and cache condition."
  }
]
```

The example is not a measured result. Imported observations are labeled `externally supplied` and summarized independently by app and cold/warm condition. Missing groups stay `unmeasured`. Never use the POC's fixed-delay smoke script as a startup measurement.

## Real-data screenshots without touching the running Electron UI

If production CDP is unavailable, `capture-electron.cjs` starts a separate hidden Electron window with the unmodified production React renderer and preload from this checkout. It connects directly to the existing daemon in connect-only mode, without daemon bootstrap, ownership registration, host flush, restart or a second host. Its Chromium profile is temporary and preferences are copied into memory only. A strict command allowlist permits saved-state reads and per-connection view subscriptions. Agent turns, writes, terminal execution and destructive commands are rejected.

This is a **limited capture shell**, not the installed Electron main process. Editors, dictation, update and notification services are disabled. It is useful for real UI and saved-data screenshots, but cannot serve as a full installed-app performance baseline. Never label screenshots as captures of the running production window. Capture metadata records provenance, the real daemon PID, calls, errors, selected state and pixel dimensions. Content-area captures omit native titlebar controls; Retina captures are 2880 by 1800 pixels for a 1440 by 900 CSS viewport.

Build the actual renderer, then provide an external JSON plan with entries like `{ "name": "chat", "chatKey": "/absolute/existing/project#existing-chat-id", "panel": "chat" }`. `panel` accepts `chat`, `designs` or `artifacts`. Use existing real Chats with saved content; no fixtures, seeded state or scripted provider replies. Do not use the example as a literal Chat key.

```sh
npm run build:renderer --workspace=milagre
env -u ELECTRON_RUN_AS_NODE MILAGRE_BACKGROUND=1 \
  "$PWD/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
  experiments/rust-desktop/perf/capture-electron.cjs \
  --plan /tmp/milagre-capture-plan.json --output /tmp/milagre-comparison
```

The helper exits after capture unless `--hold-seconds 180` keeps the final verified surface alive for an explicitly limited renderer-shell observation. Its `electron-capture.json` then reports `stage: "holding"`, the exact PID, selected Chat and rendered metadata before waiting. Use `--electron-app /absolute/checkout/node_modules/electron/dist/Electron.app --electron-pid PID` in the collector. Agent-launched capture shells are separated from their daemon ancestor, avoiding double counting in shared host work. Wait for builds/tests and the live probe to finish, verify the same visible state in Rust, warm both for 30 seconds, then collect repeated samples. These observations compare background rendering shells with different native-service scope, not complete installed applications; name that limitation beside every metric.

Use an absolute Electron executable path when collecting process samples. macOS `ps` can preserve a relative launch path; the collector deliberately rejects that path instead of assuming a process's working directory or weakening executable identity checks.

`prepare-capture.js` can also be evaluated in Rust after the real shell selects the same Chat and sets `window.__comparisonCapture` to the same plan entry. It uses actual panel controls, waits for content and fonts, and completes finite presentation animations before capture. It never replaces DOM content or application CSS. Keep all screenshots and data JSON outside Git. Compare the same preference snapshot, panel selection, viewport and transcript state; live sidebar counters can change between captures.

For named Rust captures, launch the installed Rust app in background smoke mode with `MILAGRE_RUST_SMOKE=1 MILAGRE_RUST_CAPTURE_PLAN=/tmp/milagre-capture-plan.json`. The plan must be a task-owned regular JSON file, not a symlink, at most 1 MiB. It accepts at most one entry per `chat`, `designs` and `artifacts` panel. The optional live-provider probe runs separately only when explicitly configured by its launcher; the capture plan itself never sends a Chat. The sequence waits for ordinary/workflow checks, then any configured live probe, before viewing each saved surface. It confirms the selected Chat from the actual sidebar selection or saved/generated title.

The existing `smoke_result` command accepts an optional enum label and waits for the real WebKit callback. Named captures write `/tmp/milagre-rust-chat.png`, `/tmp/milagre-rust-designs.png` and `/tmp/milagre-rust-artifacts.png`, plus each `-state.json` and `/tmp/milagre-rust-capture-LABEL.json` completion report. All writes use the Rust private-evidence helper, which rejects symlinks, wrong owners and multiple hard links. A callback timeout or encoding/write failure is an error, not success. Final `/tmp/milagre-rust-smoke.json` includes `comparison.captures` with pixel dimensions and rendered state. Native titlebar controls are outside these content-area snapshots.

## Repeated observation of the same visible content

With both captures complete and the Electron shell holding its final surface, `paired-observation.mjs` verifies the last captured Chat key, panel, title, viewport, font, colors, panel state and display scale. It warms for at least 30 seconds, then collects five sets of 11 samples by default. Each set uses the existing read-only collector and checks stable shell/host process attribution. Its summary reports per-run medians, the median of those medians, all observed ranges and usable sample counts. Raw run JSON remains beside it.

```sh
node experiments/rust-desktop/perf/paired-observation.mjs \
  --electron-report /tmp/milagre-comparison/electron-capture.json \
  --rust-smoke /tmp/milagre-rust-smoke.json --rust-pid ACTUAL_PID \
  --webkit-evidence /tmp/milagre-webkit-identities.json \
  --output /tmp/milagre-paired-observation
```

This is a same-content observation, not a fully controlled performance benchmark. Both native windows are hidden, but Electron's `paintWhenInitiallyHidden` reports `document.visibilityState=visible` while hidden WebKit reports `hidden`. The tool records both values without spoofing them. It keeps `matchedWorkload` false, does not compute a relative speedup or total-memory reduction, and discloses different native services, process histories, engine scheduling and ongoing shared backend work. Startup and foreground latency remain unmeasured.
