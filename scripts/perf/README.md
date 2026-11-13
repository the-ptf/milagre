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

Options: `--visible` (show the window, so paint and GPU work count), `--new-chat` (press ⌘N first: a new Chat's page), `--seconds n` (per scenario, or per reply in a soak), `--turns n`, `--settle n` (seconds to wait after the Chat opens), `--out file`, `--state <.milagre>`, `--heap <prefix>` (a soak writes `<prefix>-before.heapsnapshot` and `<prefix>-after.heapsnapshot`, which Chrome DevTools can compare).

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
| `firstTextMs`                                              | From sending to the reply's first text in the DOM                                          |
| `jsHeapMbPerTurn`, `footprintMbPerTurn`, `domNodesPerTurn` | Soak only: growth per reply. Steady growth means something is retained                     |

## Reading the numbers

- Runs are safe beside an open Milagre: each uses its own profile, port, `HOME` and throwaway repository, with `MILAGRE_BACKGROUND=1`, and it stops only its own processes. It doesn't touch your data.
- The window stays hidden, so paint cost isn't the same as on screen, and times are DOM insertion, not painted frames.
- `loadAverage` is saved with each result. Timing moves with what else the Mac is doing, so compare runs made under similar load and repeat them before trusting a small change. CPU share and memory are steadier than latency.
- Tested on macOS. It needs `ps` and a POSIX shell, so it won't run on Windows.
