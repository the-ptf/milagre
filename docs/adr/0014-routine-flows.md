# Routine flows run step by step in the daemon, with receipts

A Routine can be a **Flow**: steps instead of one prompt. The daemon's Routines store keeps the steps on the Routine (`flow`: the published steps, their revision, and a draft) and each Run's progress on the Run (`flow`: a copy of the steps it started on and one state per step). `routines/flow-runner.cjs` runs them; the scheduler only claims Runs and passes their Chats' events on.

- **Durable progress, no replays.** Every step's state is written before and after it acts, in the same `routines.json` transaction the store already uses. A daemon restart doesn't fail a flow Run (`recoverInterrupted` leaves it); `resume()` picks it up: a done step never runs again, a turn the restart cut off counts as a failed try, and an action with an intent but no receipt is checked rather than repeated. A pull request step looks for the PR on the Run's branch first and keeps a receipt; when gh can't say whether one exists, the step fails instead of opening a second. A Linear comment that may have posted before a stop is not posted again: the Run stops for the owner to check.
- **Typed hand-offs, not prose.** An agent step lists its fields and the agent hands them back with the `flow_step_output` tool, checked against the step's types. A turn that ends without them is asked once, then counts as a failed try. Ifs read fields, never free text.
- **Revisions.** Publishing makes the draft the steps new Runs use (`revision` + 1). A Run copies the steps it starts with, so editing or publishing never changes a Run in progress, and the Run view shows the revision it ran.
- **The owner's hand.** Ask steps and pull request steps that ask first wait for approval from any device; no answer in time ends the Run as `ended` (a new Run status that doesn't count as a failure). Runs can be paused (the step under way finishes), ended, or retried at the step they stopped at with a note for the agent.
- **Old Routines unchanged.** A Routine without `flow` runs exactly as before; nothing is migrated.

Considered and rejected: a separate SQLite database for flow Runs. The store's single atomic file already gives the transactions a step needs, and keeping Runs in one place keeps the Runs list, trimming and paired-computer routing as they are. Revisit if flow Runs make `routines.json` large.

Not covered yet: reserving an issue across Routines, so two Routines can't work the same issue. That needs a contract with the Routines that do it today.

Test runs are simulations: they never start agent Chats or execute tools. They reuse validated fields from a completed step of the last real Run, or clearly marked sample fields; actions and waits are skipped. Saved output from a failed or interrupted turn never counts as completion. External values interpolated into agent prompts retain the existing untrusted-data fencing.
