# Routine improvements from issue #234

Keep `pick-issue-start-working.md` as the original prompt. Proposed additions for future runs:

1. Reproduce a platform failure on that platform before changing behavior. A runner's `--only` filter still honors platform exclusions; invoke the check directly for its baseline. Match CI's OS, architecture, Node version, display and renderer settings.
2. Ask independent geometry and release reviewers to distinguish a product defect from a fixture defect. Give advisors the issue body directly when their read-only tools cannot run `gh`.
3. Check committed state and stable geometry rather than assuming a fixed animation delay is sufficient. Verify the requested preview identity, actual content size, composer draft and dismissed controls before measuring.
4. Use `test-milagre-app`, Milagre Tasks/phases/advisors, `gh`, and a task-owned Ubuntu environment. Keep Linux regression evidence separate from real-provider app screenshots. Existing tools suffice; no new MCP installation is proposed.
5. Use a fresh temporary profile and Project, and confirm the daemon's launch directory too. A daemon retained from an earlier launch keeps its original directory. Stop only that task-owned daemon before relaunching it from the intended Project.
