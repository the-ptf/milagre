---
name: artifacts
description: Create or update the Chat's single live HTML page for explanations, reports and interactive explainers.
---

# The live artifact page

Use `artifact_show` for a page explaining a topic, a report or an interactive explainer. For UI screens, mockups and visual design work, use `design_show` and the design skill. The user's explicit choice of another tool takes precedence.

Each Chat has one live HTML page. Every `artifact_show` call updates that page in place. Do not create variants or promise version history. To revise existing content, use `artifact_list` to find its id and `artifact_read` to read the current page first. Preserve content the user has not asked to change.

Supply a title and one self-contained HTML document with inline styles and scripts. Use a width and height appropriate to the content (defaults 1280 by 800). Keep source below 1,000,000 characters. Keep styles and scripts inline. Shared Artifacts block all external resources, including remote images, fonts and scripts: attach the files a page shows (see Photos, videos and files). No secret, local file or private Chat content belongs in an artifact unless the user requested it.

## Tabs

When a page covers parts the reader takes one at a time (an overview and its details, one section per component, a report and its raw data), split it into tabs: send `tabs` instead of `html`, each with an id, a short title and its own self-contained HTML document. Milagre draws the tab bar above the page, on desktop, phone and shared pages; don't draw one in the HTML. Keep one page without tabs when it reads top to bottom, and at most 20 tabs. Each tab is a page of its own: repeat the styles it needs.

To change one tab, read it with `artifact_read` and its `tab` id, then send every tab in order with `html` only on the ones you changed: a tab without `html` keeps what it has. Leaving a tab out removes it. A comment on a tab names its id ("on the tab data ..."); read that tab before changing it.

## Photos, videos and files

To show a photo, video, recording, font or any other file, save it in the Chat's Worktree, then attach it in `artifact_show`'s `assets` with a name and its absolute path, and use it in the HTML as `assets/<name>`: `<video src="assets/demo.mp4" controls>`, `<img src="assets/chart.png">`, `url(assets/font.woff2)`. Don't base64-encode files into the HTML. Milagre copies each file when you call `artifact_show`, so you can delete it from the Worktree afterwards. It shows on desktop, on the phone and on shared pages.

Names are letters, digits, dots, dashes and underscores, with no folders. A file is up to 95 MB, a page's files up to 1 GB together. Attach a file once: later calls keep it while any tab's HTML still mentions `assets/<name>`, and drop it when none does. Attaching a file under a name the page already has replaces it. `artifact_read` lists the page's files.

## Diagrams

For a flowchart, sequence, state, class or ER diagram, a timeline, a Gantt or pie chart, a mind map or any other Mermaid diagram, put its Mermaid text in a `<pre class="mermaid">` block. Milagre draws it in place with Pele, offline and on shared pages, in the colours of the text and background around it, fitted to the page's width (a left-to-right flowchart turns top-down on a phone). Do not load mermaid.js or any other script for it: remote scripts are blocked. Escape `<`, `>` and `&` in the diagram text. To set the colours yourself, set `--pele-bg`, `--pele-fg`, `--pele-line`, `--pele-surface`, `--pele-border` and `--pele-accent` on the block.

## Comments

The user can comment on the page. A comment pinned on it says where, as a share of the page across and down, and quotes the text near the spot ("near ..."): find the spot by that text, since the page may lay out differently on their screen. After addressing a comment, call `artifact_resolve_comment` with its id and a short note. Sharing publishes a frozen copy of the current page; later edits stay private until published again. Only the user can publish through the sharing controls.
