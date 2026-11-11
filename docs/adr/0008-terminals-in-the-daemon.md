# Terminals run in the daemon, with no control lease and no saved output

A Terminal's shell runs under the daemon's PTY, not in the Electron main process, so it keeps running when the desktop app closes and a paired phone can view and type in it. This follows ADR-0003: the daemon owns every process Milagre starts. Terminals end when their shell exits, when their Chat is archived, or when the daemon stops or restarts; nothing brings them back after a restart.

Output is kept only in the daemon's memory, about the last 10,000 lines or 1 MB per Terminal, enough to show earlier output when a viewer reopens it. It is never written to disk, because passwords and tokens pass through terminals and Chat transcripts are not the place for them.

Unlike a Browser page (ADR-0016), a Terminal has no control lease. Every viewer can type at once, as in a shared tmux session, and the PTY takes the size of the viewer that typed or focused last. The common case is moving from the Mac to the phone mid-command; a Take control step would get in the way, and a shell has no held keys or mouse button that a lease would need to release.

## Considered Options

- Run the shell in the Electron main process: simpler, but it dies on desktop quit and the phone can never reach it.
- Persist scrollback to disk so Terminals reappear after a daemon restart: rejected for the secrets reason above.
- Reuse the Browser page control lease: rejected, see above.
