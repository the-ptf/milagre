---
name: artifacts
description: Create or update the Chat's single live HTML page for explanations, reports and interactive explainers.
---

# The live artifact page

Use `artifact_show` for a page explaining a topic, a report or an interactive explainer. For UI screens, mockups and visual design work, use `design_show` and the design skill. The user's explicit choice of another tool takes precedence.

Each Chat has one live HTML page. Every `artifact_show` call updates that page in place. Do not create variants or promise version history. To revise existing content, use `artifact_list` to find its id and `artifact_read` to read the current page first. Preserve content the user has not asked to change.

Supply a title and one self-contained HTML document with inline styles and scripts. Use a width and height appropriate to the content (defaults 1280 by 800). Keep source below 1,000,000 characters. Embed assets and keep styles and scripts inline. Shared Artifacts block all external resources, including remote images, fonts and scripts. No secret, local file or private Chat content belongs in an artifact unless the user requested it.

The user can comment on the page. After addressing a comment, call `artifact_resolve_comment` with its id and a short note. Artifacts remain available when Designs is off. Sharing publishes a frozen copy of the current page; later edits stay private until published again. Only the user can publish through the sharing controls.
