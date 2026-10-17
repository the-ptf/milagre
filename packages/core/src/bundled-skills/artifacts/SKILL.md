---
name: artifacts
description: Create or update the Chat's single live HTML page for explanations, reports and interactive explainers.
---

# The live artifact page

Use `artifact_show` for a page explaining a topic, a report or an interactive explainer. For UI screens, mockups and visual design work, use `design_show` and the design skill. The user's explicit choice of another tool takes precedence.

Each Chat has one live HTML page. Every `artifact_show` call updates that page in place. Do not create variants or promise version history. To revise existing content, use `artifact_list` to find its id and `artifact_read` to read the current page first. Preserve content the user has not asked to change.

Supply a title and one self-contained HTML document with inline styles and scripts. Use a width and height appropriate to the content (defaults 1280 by 800). Keep source below 1,000,000 characters. Embed assets and keep styles and scripts inline. Shared Artifacts block all external resources, including remote images, fonts and scripts. No secret, local file or private Chat content belongs in an artifact unless the user requested it.

## Diagrams

For a flowchart, sequence, state, class or ER diagram, a timeline, a Gantt or pie chart, a mind map or any other Mermaid diagram, put its Mermaid text in a `<pre class="mermaid">` block. Milagre draws it in place with Pele, offline and on shared pages, in the colours of the text and background around it, fitted to the page's width (a left-to-right flowchart turns top-down on a phone). Do not load mermaid.js or any other script for it: remote scripts are blocked. Escape `<`, `>` and `&` in the diagram text. To set the colours yourself, set `--pele-bg`, `--pele-fg`, `--pele-line`, `--pele-surface`, `--pele-border` and `--pele-accent` on the block.

## Comments

The user can comment on the page. A comment pinned on it says where, as a share of the page across and down, and quotes the text near the spot ("near ..."): find the spot by that text, since the page may lay out differently on their screen. After addressing a comment, call `artifact_resolve_comment` with its id and a short note. Artifacts remain available when Designs is off. Sharing publishes a frozen copy of the current page; later edits stay private until published again. Only the user can publish through the sharing controls.
