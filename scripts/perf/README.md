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
- `loadAverage` is saved with each result. Timing moves with what else the Mac is doing, so compare runs made under similar load and repeat them before trusting a small change. CPU share and memory are steadier than latency.
- Tested on macOS. It needs `ps` and a POSIX shell, so it won't run on Windows.
