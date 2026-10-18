Pick one issue from the issues list on github, start working on it until its finished. The work must be:

- Human free - the issue can and should be executed without an human involved
- Decision free - decisions taht would need an human can be passed to different models with personas and perpectives so together they decide (like Claude Opus, GPT 6 Astra and Antigravity Argon)
- Errors shouldnt stop an execution - the end goal is to have the work done, so any error MUST be fixed and the agent should get around things that are limitant for them
- Design pattern - follow all the design patterns from the current Milagre codebase
- Ready - when finishes, an artifact must be published with a public link placed on the top of the pr alongside with a PR with screenshots so the human can review later when he can or he needs. The screenshots should be images IN the artifact (not links to an image).
- Responsive - works that are done should be ready for both Desktop AND mobile, unless the issue specifies one platform only.

More important, the work should be tested throughfully, making sure that edge cases are covered. and here i don't mean to write unit or end to end tests, but I mean running the work you've done locally.

You self improve yourself. If not created yet, create a .milagre/routines/pick-issue-start-working.md in this repo and propose changes, skills, mcps, etc that can be called in this prompt. The file should be this prompt itself.

If nothing needs doing, reply starting with "(pass)" and a short reason.
