# Routines

How Routine Flows run step by step in the daemon without repeating an action after a restart.

A Flow is a Routine with steps instead of one prompt. The Routines store keeps the steps on the Routine (`flow`: published steps, revision and draft) and each Run's progress on the Run (`flow`: a copy of the steps it started with and one state per step). `routines/flow-runner.cjs` runs them; the scheduler only claims Runs and forwards their Chats' events. A Routine without `flow` runs as a single prompt, unchanged.

- **Receipts, not replays.** Each step's state is written before and after it acts, in the same `routines.json` transaction the store already uses. A restart doesn't fail a flow Run; `resume()` picks it up. A done step never runs again, a cut-off turn counts as a failed try, and an action with an intent but no receipt is checked, not repeated. A pull request step looks for a PR on the Run's branch first; if gh can't tell, the step fails rather than open a second. A Linear comment that may have posted stops the Run for the owner to check.
- **Typed hand-offs.** An agent step declares fields, and the agent returns them with `flow_step_output`, checked against their types. A turn that ends without them is asked once, then counts as a failed try. Ifs read fields, never free text. Output from a failed or interrupted turn never counts as completion.
- **Revisions.** Publishing makes the draft the steps new Runs use. A Run copies its steps at start, so edits never change a Run in progress, and the Run view shows its revision.
- **Owner approval.** Ask steps, and pull request steps that ask first, wait for approval from any device. No answer in time ends the Run as `ended`, which isn't a failure. Runs can be paused (the current step finishes), ended, or retried at the step they stopped with a note to the agent.
- **Test runs** are simulations: no agent Chats, no tools. They reuse fields from a completed step of the last real Run or clearly marked samples, and skip actions and waits.
- External values put into agent prompts stay fenced as untrusted data.

Rejected: a separate SQLite database for flow Runs. The store's single atomic file already gives each step its transaction, and one place keeps the Runs list, trimming and paired-computer routing as they are. Revisit if flow Runs make `routines.json` large.

Open: no reservation stops two Routines from working the same issue. That needs a contract with the Routines that pick issues today.
