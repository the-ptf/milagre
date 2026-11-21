# Desktop performance runs

Repeatable measurements of the built desktop app: no agent, no network, the same reply at the same pace every run. Use them for a before and after on a change, and to chase memory growth.

`fake-claude.cjs` stands in for `claude` and streams a scripted reply. `run.cjs` starts its own copy of the app, drives it and writes a JSON result. The idea comes from MonoCode's `scripts/perf`.

## Run

```sh
npm run build:renderer --workspace milagre
npm run perf -- idle                 # 60 s with nothing happening
npm run perf -- stream               # one 45 s reply of mixed Markdown
npm run perf -- code                 # one 45 s reply that is a single growing code block
npm run perf -- soak --turns 20      # replies back to back, memory after a forced GC after each
npm run perf -- compare before.json after.json
```

Launch time has its own script. It starts the app several times in a row and reports the median of every launch after the first (the first also starts the background host; later ones find it running, as most real launches do):

```sh
node scripts/perf/launch.cjs --app release/mac-arm64/Milagre.app --runs 7   # a packaged build
node scripts/perf/launch.cjs                                                # Electron on apps/desktop and dist/
node scripts/perf/launch.cjs compare before.json after.json
```

It reports `windowMs` (spawn to the window's page starting to load: the main process's own start), `firstPaintMs` (the renderer's first contentful paint) and `sidebarMs` (the first sidebar row, once the host has answered), all from the spawn, plus `appArchiveMb` for a packaged build. Package with `npx electron-builder --mac dir --arm64 --publish never --config.mac.identity=- --config.mac.notarize=false` after `npm run build`.

`cpu` is the CPU seconds each kind of process used in the first `--window` seconds (default 8) after the spawn: main, renderer, GPU, utility and the host's share of that window. With `--trace`, the main process and the host load `trace-spawns.cjs`, every process they start runs under `trace-exec.sh`, and `mainChildren` and `hostChildren` add those processes' CPU; each launch's `children` lists them with their command, start, wall and CPU time and the code that started them. A traced child pays for the wrapper's bash (a few ms), so compare traced runs with traced runs. `--real-clis` drops the `claude` stub and links your own Claude Code into the fake home, so the host finds the real CLIs on the launchd `PATH` plus its install folders. The home stays fake, so every CLI is signed out: no prompt is ever sent, and signed-out answers are not cached the way signed-in ones are.

`--projects n` registers n Projects before the first launch, through the checkout's own registry and recents: the run's repository and n - 1 others, each with a GitHub-style `origin` under one of three owners, two Worktrees and a Chat in each checkout. Without it the app registers the one repository itself on its first launch. The host's `fetch` and `gh` go through a proxy that refuses every connection, so nothing leaves the computer.

For a before and after, keep a copy of the baseline checkout with its own `node_modules` and built renderer (on macOS `cp -cR` makes one in seconds; delete its `.git` file) and pass `--root <copy>`, alternating with runs of your checkout. `--dist <folder>` points at another built renderer.

Options: `--visible` (show the window, so paint and GPU work count), `--new-chat` (press ⌘N first: a new Chat's page), `--seconds n` (per scenario, or per reply in a soak), `--turns n`, `--settle n` (seconds to wait after the Chat opens), `--out file`, `--state <.milagre>`, `--heap <prefix>` (a soak writes `<prefix>-before.heapsnapshot` and `<prefix>-after.heapsnapshot`, which Chrome DevTools can compare).

For a before and after of the renderer, build each into its own folder and pass `--dist <folder>`; alternate the two runs so both see the same load. `--flag <switch>` adds a Chromium switch (repeat it for several), `--profile <file>` saves a CPU profile of the reply and `--no-frames` leaves out the frame probe, whose `requestAnimationFrame` loop asks for a frame every vsync and hides what an otherwise still window costs. `PERF_INTERVAL_MS=2000` makes the stub stream a chunk every 2 s: an agent at work with little output, where the run indicators are most of the cost.

Debug output, by environment variable: `PERF_LAYERS=1` prints the composited layers with why each exists, the running animations and the elements with a backdrop filter; `PERF_TRACE=<file>` saves a 4 s Chromium trace from the middle of the reply (count `DrawFrame` per process); `PERF_SHOT=<prefix>` saves the window at the end of the reply and scrolled up a little.

`--state` copies a real Project's `.milagre` into the throwaway repository, gives every Worktree its own path and removes the provider session ids, so a soak can run against real transcripts. The run uses the first Chat in the sidebar, which has to be a Claude Chat. Without `--state` it uses one small synthetic Chat. Compare runs made the same way only.

## What it reports

| Field                                                      | Meaning                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `cpuPercent`                                               | CPU per process kind over the run, as a share of one core                                  |
| `jsHeapMb`                                                 | JS heap after a forced GC                                                                  |
| `rendererFootprintMb`                                      | Physical footprint of the largest renderer (`footprint` on macOS, resident size elsewhere) |
| `domNodes`, `listeners`                                    | Live DOM counters                                                                          |
| `longTasks`, `longestTaskMs`                               | Main-thread tasks over 50 ms                                                               |
| `frameP50Ms`, `frameP99Ms`, `framesOver50Ms`               | Gaps between animation frames                                                              |
| `footprintMb`                                              | Physical footprint per process kind: the GPU process is usually the largest                |
| `layers`, `layerMegapixels`                                | Composited layers that draw content, and the pixels they cover                             |
| `mainThreadPerSecond`                                      | Style recalcs, layouts and task time per second while the reply runs                       |
| `firstTextMs`                                              | From sending to the reply's first text in the DOM                                          |
| `jsHeapMbPerTurn`, `footprintMbPerTurn`, `domNodesPerTurn` | Soak only: growth per reply. Steady growth means something is retained                     |

## Reading the numbers

- Runs are safe beside an open Milagre: each uses its own profile, port, `HOME` and throwaway repository, with `MILAGRE_BACKGROUND=1`, and it stops only its own processes. It doesn't touch your data.
- The window stays hidden, so paint cost isn't the same as on screen, and times are DOM insertion, not painted frames.
- The hidden window gets focus at the first DevTools input event, not at `element.focus()`, so the run presses Shift before the settle. Otherwise the window's focus listeners (the simulator pill and the Browser panel list again) would run as the prompt is typed, 150 ms before Enter, and work in that gap wakes the CPU: the Git calls and the agent spawn between Enter and the first chunk then run 10–30 ms faster, and a change that drops work from a focus listener reads as slower `firstTextMs`. A person's window has focus long before they press Enter.
- `loadAverage` is saved with each result. Timing moves with what else the Mac is doing, so compare runs made under similar load and repeat them before trusting a small change. CPU share and memory are steadier than latency.
- Tested on macOS. It needs `ps` and a POSIX shell, so it won't run on Windows.

## Simulator viewer

`simulator.cjs` measures the simulator viewer from tap to painted pixel. It needs a booted iPhone simulator (or a running Android emulator with Chrome past its first-run screens) and nothing built:

```sh
npm run perf:simulator                                   # iOS: desktop, LAN and relay paths, still and animating screen
npm run perf:simulator -- --platform android
npm run perf:simulator -- --paths desktop --scenes still --seconds 10 --taps 10
npm run perf:simulator -- compare before.json after.json
```

It opens `simulator-fixture.html` in the device's browser: a tile that changes colour on every touch, over a background that stays still or animates every frame (`?mode=animate`). For each path it starts its own daemon (`simulator-host.cjs`) with phone access on, a local relay running the real room code, and an Electron window holding the same receiver page and simulator bridge as the Simulators panel. Taps go in as pointer events on that page, so they take the viewer's real input path. A probe in the receiver page samples every frame the viewer paints, whatever drew it (`<img>`, the WebCodecs canvas or `<video>`), so the numbers hold across transports.

| Path      | Viewer to daemon                                                                           |
| --------- | ------------------------------------------------------------------------------------------ |
| `desktop` | The daemon's socket, as the desktop app's main process                                     |
| `lan`     | The phone app's encrypted transport (`apps/mobile/src/relay-transport.ts`) to the LAN host |
| `relay`   | The same transport through a local relay                                                   |

Options: `--device <udid or serial>` (default: the first booted iPhone, or the first emulator), `--seconds n` (passive window per run, default 20), `--taps n` (default 30), `--visible` (an on-screen window instead of offscreen rendering), `--out file`.

Results are keyed `<path>.<scene>`:

| Field                                       | Meaning                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tapToPhotonMs`                             | p50/p95/p99 from the viewer's `pointerdown` to the first animation frame after the new colour was decoded |
| `tapToDecodeMs`                             | The same, to the decoded frame                                                                            |
| `tapMisses`                                 | Taps with no new colour within 3 s                                                                        |
| `ttffMs`                                    | Receiver start to its first painted frame; `cold` marks the first run of a path, when the helper starts   |
| `paintedFps`, `changedFps`                  | Frames painted per second, and those whose pixels changed                                                 |
| `frameIntervalMs`, `frameIntervalStddevMs`  | Gaps between changed frames on the animating screen, between painted frames on the still one              |
| `freezesPerMinute`, `longestGapMs`          | Animating screen only: gaps over 200 ms without a changed frame                                           |
| `viewerMessagesPerSec`, `viewerBytesPerSec` | Replies reaching the viewer, and their size                                                               |
| `wireBytesPerSec`                           | Phone paths: encrypted bytes on the socket                                                                |
| `cpuPercent`                                | Share of one core: `daemon` (the host process), `helper` (its child processes), `viewer` (Electron)       |

The phone paths measure the phone's transport, not its WebView: frames are decoded by Electron's Chromium on this Mac, and the phone app's step of writing each frame to a file is left out. The local relay leaves out the internet round trip to `relay.milagre.cloud`. Leave the device alone while it runs: the bench taps it for a few minutes and returns an Android emulator to its home screen.
