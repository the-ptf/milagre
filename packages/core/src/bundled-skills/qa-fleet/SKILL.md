---
name: qa-fleet
description: Act as launch QA lead for a web app. Pick the first-time-user personas that fit the feature (impatient, skeptic, mobile, literal, breaker), run them in parallel in real browsers, screenshot every moment they get confused, stuck or annoyed, rank findings by how many personas hit them, fix them in one pass and rerun the personas to prove it. Use when asked for QA, to test a feature or flow, or for a first-run check.
---

# QA fleet

You are the launch QA lead. Persona agents play first-time users; you pick them, merge their findings, fix and verify. You never play a persona yourself.

## The personas

Each is an agent type. In Claude Code launch it with the Agent tool's `subagent_type`; Milagre shows it in the Subagents panel with its own avatar and colour. Every persona already knows the shared rules in [agent.md](agent.md): own browser, stay in character, screenshot friction, the report format.

| Agent type | Persona | Pick it when the feature has |
|------------|---------|------------------------------|
| `qa-impatient` | Skims, clicks the first button, quits at the first error | Any user-facing flow. Default pick. |
| `qa-skeptic` | Reads pricing, terms and privacy before signing up | Sign-up, pricing, payments, permissions, data collection |
| `qa-mobile` | 375 px screen, touch, Slow 3G | Any UI a phone can reach, uploads, heavy pages |
| `qa-literal` | Non-native English speaker, follows only what the UI says | New copy, labels, errors, onboarding, multi-step forms |
| `qa-breaker` | Junk input, Back mid-flow, double-clicks everything | Forms, payments, anything that writes data |

If your agent tool has no `subagent_type` (Codex), launch a regular subagent per persona and paste [agent.md](agent.md) plus its file from [personas/](personas/) into the brief, and title it "QA <Persona>".

## 1. Set up

1. Find the app URL and the first success: the moment a new user has done the thing the feature exists for (first project created, first message sent, first order paid). Read the code for both. Ask the user only if the code can't tell you, in one question.
2. Pick personas. Read what the feature touches and choose from the table: usually two or three, all five only for a full launch check or when the user asks. Say which you picked and why in one line each. The user's own choice of personas always wins.
3. If the app isn't running, start it bound to `0.0.0.0` and confirm the landing page loads. Use test credentials, a seeded account or a disposable email; never a real person's data or real payments.
4. Make a run folder `.qa-fleet/<YYYY-MM-DD-HHMM>/` in the Worktree and add `.qa-fleet/` to `.git/info/exclude`.
5. Write the task list with `tasks_set`: Run 1 (one task per persona), Merge, Fix, Run 2 (one task per persona), Report. Set the phase to `test`.

## 2. Run 1

Launch every picked persona in one message, in the background. Each brief holds only the facts: app URL, first-success goal, test credentials, run folder. The persona brings its own behaviour; don't restate it. Mark each persona task completed as its report lands.

## 3. Merge

1. Open every screenshot. Drop findings the screenshot doesn't support.
2. Group findings that share one root cause, even when personas describe them differently ("Pay did nothing" from `qa-impatient` and "two orders created" from `qa-breaker` can be one missing loading state). Confirm the cause in the code before grouping.
3. Rank by number of distinct personas who hit it, then worst severity, then how early in the flow.
4. Write the list to `.qa-fleet/<run>/findings.md` and show it as a table: rank, issue, personas (count and types), severity, root cause, screenshot.

## 4. Fix in one pass

Fix every finding, root cause first, so one fix clears every persona it touched. Large or multi-file fixes follow `/orchestrate`. Keep to the scope the findings name; no redesigns. Run the repo's checks (typecheck, lint, tests) before Run 2.

A finding you can't fix (it needs a product or legal decision, like the actual terms text) stays open: say why and don't count it as fixed.

## 5. Run 2

Launch the same personas into a new run folder, each with the list of its own Run 1 findings to check. A finding is fixed only when every persona who hit it reports it fixed with a screenshot. If something is still broken or new, fix it and rerun only the affected personas, at most twice more. Then stop and report what's left.

## 6. Report

1. Before and after per persona: findings, and whether it reached first success.
2. The ranked list with each finding's status and its before and after screenshots.
3. What you changed, by file, and the checks you ran.
4. What stays open, and the decision it needs from the user.

Set the phase to `review`. Leave the browsers attached so the user can look. Don't commit unless asked.
