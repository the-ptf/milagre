import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  artifactTab,
  onArtifactTab,
  ARTIFACT_CSP,
  ARTIFACT_PAGE,
  ARTIFACT_PAGE_SCRIPT,
  ARTIFACT_SHELL_SCRIPT,
  DESIGNS_CANVAS_SCRIPT,
  RESOLVED_STEP,
  artifactDocument,
  artifactShell,
  hasDiagrams,
  nearText,
  readPageMessage,
  sentNumbers,
  chosenDesign,
  designActivity,
  designsCanvasShell,
  designGroups,
  designFeedbackMessage,
  designFeedbackText,
  newCommentId,
  parseDesignFeedback,
  resolutionNotes,
} from "./artifact.ts";
import { replyActivity } from "./reply-parts.ts";

const policy = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
const escape = /<script>[^<]*milagre:artifact-escape[^<]*<\/script>/.exec(artifactDocument(""))![0];

test("the policy comes first, after the doctype, ahead of anything the design wrote", () => {
  assert.equal(
    artifactDocument('<!-- hi --><!doctype html><html><head lang="en"><title>x</title></head></html>'),
    `<!-- hi --><!doctype html>${policy}${escape}<html><head lang="en"><title>x</title></head></html>`,
  );
  assert.equal(artifactDocument("<html><body>hi</body></html>"), `<!doctype html>${policy}${escape}<html><body>hi</body></html>`);
  assert.match(
    artifactDocument("<div>hi</div>"),
    /^<!doctype html><meta http-equiv="Content-Security-Policy"[^>]+><meta charset="utf-8"><meta name="viewport"[^>]+><script>.*<\/script><div>hi<\/div>$/,
  );
});

test("a decoy <head> in a comment or a script string can't take the policy", () => {
  for (const html of ["<html><!-- <head> --><head></head><body></body></html>", '<html><script>var s="<head>"</script><head></head></html>']) {
    const document = artifactDocument(html);
    assert.ok(document.startsWith(`<!doctype html>${policy}${escape}<html>`), document);
  }
});

test("the policy blocks requests the design makes itself", () => {
  assert.match(ARTIFACT_CSP, /default-src 'none'/);
  assert.doesNotMatch(ARTIFACT_CSP, /connect-src/);
  assert.equal(
    ARTIFACT_CSP.split("; ").find((directive) => directive.startsWith("script-src")),
    "script-src 'unsafe-inline'",
  );
});

test("feedback remains human-readable without preview cards or agent instructions", () => {
  const design = { id: "login", title: "Login", version: 2 };
  assert.equal(
    designFeedbackText({
      choice: design,
      comments: [{ design, id: "12345678", nodeId: "button", x: 0.5, y: 0.5, text: "Make this bigger.\nKeep the color." }],
    }),
    "Chose Login (version 2).\n\nLogin (version 2): Make this bigger.\nKeep the color.",
  );
  assert.equal(designFeedbackText({ comments: [] }), "");
});

test("a finished design leaves the activity to show as a card; one still running or failed stays a row", () => {
  const done = {
    id: "a",
    kind: "artifact" as const,
    title: "Showed `Login`",
    status: "done" as const,
    offset: 0,
    artifact: { id: "x1", version: 1, title: "Login" },
  };
  const running = { id: "b", kind: "artifact" as const, title: "Showed `Card`", status: "running" as const, offset: 0 };
  const reply = replyActivity("Here it is.", [done, running]);
  assert.deepEqual(reply.artifacts, [done]);
  assert.deepEqual(reply.activity, [{ type: "step", step: running }]);
});

test("feedback names each design and where on it a comment was pinned", () => {
  const login = { id: "login", version: 2, title: "Login" };
  assert.equal(
    designFeedbackMessage({
      comments: [
        { design: login, x: 0.42, y: 0.181, text: " Bigger button " },
        { design: { id: "home", version: 1, title: "Home" }, text: "Too busy" },
      ],
    }),
    'Comments on the designs:\n\n1. On the design "Login" (login, version 2), 42% across and 18% down: Bigger button\n2. On the design "Home" (home, version 1): Too busy\n\nRead the latest design with design_read, then revise its layers with design_apply and expectedVersion. Keep its id.',
  );
});

test("editable feedback keeps the selected layer and asks for a version-safe edit", () => {
  const comment = { design: { id: "welcome", version: 2, title: "Welcome" }, x: 0.5, y: 0.25, nodeId: "heading", id: "1234abcd", text: "Use a larger title" };
  const message = designFeedbackMessage({ comments: [comment] });
  assert.match(message, /layer "heading"/);
  assert.match(message, /design_apply and expectedVersion/);
  assert.doesNotMatch(message, /artifact_read|artifact_show/);
  assert.deepEqual(parseDesignFeedback(message), { choice: null, comments: [comment] });
});

test("feedback without a pinned layer still requests a version-safe structured edit", () => {
  const comment = { design: { id: "welcome", version: 2, title: "Welcome" }, text: "Use a larger title" };
  const message = designFeedbackMessage({ comments: [comment] });
  assert.match(message, /design_read/);
  assert.match(message, /design_apply and expectedVersion/);
  assert.doesNotMatch(message, /artifact_read|artifact_show/);
  assert.deepEqual(parseDesignFeedback(message), { choice: null, comments: [comment] });
});

test("retired feedback instructions still parse as historical comments", () => {
  const body = 'A comment on the designs:\n\n1. On the design "Home" (home, version 1): Bigger title\n\nRevise them with artifact_show and keep their ids.';
  assert.deepEqual(parseDesignFeedback(body), { choice: null, comments: [{ design: { id: "home", title: "Home", version: 1 }, text: "Bigger title" }] });
});

test("a choice leads the feedback, and reads back as the chosen design", () => {
  const choice = { id: "home-b", version: 3, title: "Home, variant B" };
  const alone = designFeedbackMessage({ choice, comments: [] });
  assert.equal(alone, 'I chose the design "Home, variant B" (home-b, version 3). Continue from this one.');
  const both = designFeedbackMessage({ choice, comments: [{ design: choice, text: "Darker" }] });
  assert.match(both, /^I chose the design "Home, variant B" \(home-b, version 3\)\. Continue from this one\.\n\nA comment on the designs:/);
  assert.deepEqual(chosenDesign(["hi", designFeedbackMessage({ choice: { id: "a", version: 1, title: "A" }, comments: [] }), both, "thanks"]), {
    id: "home-b",
    version: 3,
  });
  assert.equal(chosenDesign(['I chose the design "x" (y, version 1). Continue from this one. And more']), null);
});

test("a reply shows each design once, at the newest version it made", () => {
  const show = (id: string, version: number) => ({
    id: `${id}${version}`,
    kind: "artifact" as const,
    title: "Showed",
    status: "done" as const,
    offset: 0,
    artifact: { id, version, title: id },
  });
  const reply = replyActivity("Three designs.", [show("home", 1), show("alt-b", 1), show("home", 2), show("alt-c", 1)]);
  assert.deepEqual(
    reply.artifacts.map((step) => [step.artifact.id, step.artifact.version]),
    [
      ["home", 2],
      ["alt-b", 1],
      ["alt-c", 1],
    ],
  );
});

test("feedback reads back from its message, and nothing else does", () => {
  const choice = { id: "home", version: 2, title: 'Home "B"' };
  const comments = [
    { design: { id: "login", version: 1, title: "Login" }, x: 0.55, y: 0.38, text: "I don't like this yellow" },
    { design: choice, text: "More air: here" },
  ];
  assert.deepEqual(parseDesignFeedback(designFeedbackMessage({ choice, comments })), { choice, comments });
  assert.deepEqual(parseDesignFeedback(designFeedbackMessage({ choice, comments: [] })), { choice, comments: [] });
  assert.deepEqual(parseDesignFeedback(designFeedbackMessage({ comments: [comments[0]!] })), { choice: null, comments: [comments[0]] });
  assert.equal(parseDesignFeedback("make it warmer"), null);
  assert.equal(parseDesignFeedback(`${designFeedbackMessage({ comments })}\n\nAnd one more thing`), null);
});

test("comments with ids tell the agent how to resolve them, and read back with their ids", () => {
  const design = { id: "login", version: 2, title: "Login" };
  const message = designFeedbackMessage({ comments: [{ design, x: 0.5, y: 0.25, text: "Bigger button", id: "0a1b2c3d" }] });
  assert.match(
    message,
    /^A comment on the designs:\n\n1\. \(comment 0a1b2c3d\) On the design "Login" \(login, version 2\), 50% across and 25% down: Bigger button\n\n/,
  );
  assert.match(message, /resolve it with artifact_resolve_comment and its comment id\.$/);
  assert.deepEqual(parseDesignFeedback(message)?.comments, [{ design, x: 0.5, y: 0.25, text: "Bigger button", id: "0a1b2c3d" }]);
});

test("the phone's shell frames the design with no say over the page, and loads nothing else", () => {
  const shell = artifactShell('<p class="a">"hi" & bye</p>');
  assert.match(shell, /frame-src 'none'/);
  assert.match(shell, /<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="/);
  assert.doesNotMatch(shell, /allow-same-origin|allow-top-navigation/);
  const outside = shell.replace(/srcdoc="[^"]*"/, "");
  assert.equal(outside.match(/<script>/g)?.length, 1, "the page itself runs only the go-between");
  assert.ok(outside.includes(`<script>${ARTIFACT_SHELL_SCRIPT}</script>`));
  const srcdoc = /srcdoc="([^"]*)"/.exec(shell)?.[1] ?? "";
  assert.ok(srcdoc.includes("&quot;hi&quot; &amp; bye"), srcdoc);
  assert.ok(srcdoc.includes("milagre:artifact-page"), "the framed page carries the page helper");
  assert.doesNotMatch(srcdoc, /var pele=/, "a page without diagrams doesn't carry Pele");
});

test("an Artifact page carries its helper, and Pele only when it has a Mermaid block", () => {
  const pele = "var pele={mount:function(){}}";
  const plain = artifactDocument("<p>No diagram</p>", { page: true, diagrams: pele });
  assert.ok(plain.includes(`<script>${ARTIFACT_PAGE_SCRIPT}</script>`));
  assert.ok(!plain.includes(pele));
  const drawn = artifactDocument('<pre class="mermaid">flowchart LR\n A --> B</pre>', { page: true, diagrams: pele });
  assert.ok(drawn.indexOf(`<script>${pele}</script>`) < drawn.indexOf(ARTIFACT_PAGE_SCRIPT), "Pele loads before the helper that mounts it");
  assert.equal(artifactDocument("<p>x</p>"), artifactDocument("<p>x</p>", {}), "designs get neither");
  assert.doesNotMatch(ARTIFACT_PAGE_SCRIPT, /<\/script|<!--/i);
  assert.doesNotMatch(ARTIFACT_SHELL_SCRIPT, /<\/script|<!--/i);
  assert.ok(ARTIFACT_PAGE_SCRIPT.includes(`"${ARTIFACT_PAGE}"`));
  for (const script of [ARTIFACT_PAGE_SCRIPT, ARTIFACT_SHELL_SCRIPT]) assert.equal(typeof new Function(script), "function", "the script parses");
});

test("Mermaid blocks are found the ways pages write them", () => {
  for (const html of ['<pre class="mermaid">', "<div class='diagram mermaid'>", '<pre><code class="language-mermaid">', "<pre class=mermaid>"])
    assert.equal(hasDiagrams(html), true, html);
  for (const html of ["<p>mermaid</p>", '<div class="mermaids">', '<div data-class="mermaid">']) assert.equal(hasDiagrams(html), false, html);
});

test("a page comment names the text near it, and reads back with it", () => {
  const design = { id: "explainer", title: "How it works", version: 3, format: "html" as const };
  const message = designFeedbackMessage({
    comments: [{ design, id: "0a1b2c3d", x: 0.42, y: 0.7, near: 'Why "requests"\n  queue', anchor: "main:1/p:2@0.5,0.5", text: "Add the retry timing" }],
  });
  assert.match(
    message,
    /^A comment on the artifact:\n\n1\. \(comment 0a1b2c3d\) On the artifact "How it works" \(explainer\), 42% across and 70% down, near "Why requests queue": Add the retry timing\n\n/,
  );
  assert.doesNotMatch(message, /main:1/, "the anchor is for the page, not the agent");
  assert.deepEqual(parseDesignFeedback(message)?.comments, [
    {
      design: { id: "explainer", title: "How it works", version: 1, format: "html" },
      id: "0a1b2c3d",
      x: 0.42,
      y: 0.7,
      near: "Why requests queue",
      text: "Add the retry timing",
    },
  ]);
  // Cut at 80 characters, the word the cut may have split goes too.
  assert.equal(nearText("x".repeat(70) + " tail of a long heading"), `${"x".repeat(70)} tail of\u2026`);
});

test("sent comments are numbered within the message that carried them", () => {
  const numbers = sentNumbers([
    { id: "a", createdAt: 1 },
    { id: "b", createdAt: 1 },
    { id: "c", createdAt: 2 },
  ]);
  assert.deepEqual(
    [...numbers],
    [
      ["a", 1],
      ["b", 2],
      ["c", 1],
    ],
  );
});

test("only the page helper's own messages, by shape, reach the viewer", () => {
  assert.deepEqual(readPageMessage({ t: "press", x: 1.4, y: 0.5, a: "p:1@0,0", near: 'a "b"', sx: 10, sy: 20 }), {
    t: "press",
    x: 1,
    y: 0.5,
    a: "p:1@0,0",
    near: "a b",
    sx: 10,
    sy: 20,
  });
  assert.deepEqual(readPageMessage({ t: "anchor", k: "k1", sx: 1, sy: 2 }), { t: "anchor", k: "k1", sx: 1, sy: 2, shown: true });
  assert.deepEqual(readPageMessage({ t: "zoom", dy: -3, cx: 1, cy: 2 }), { t: "zoom", dy: -3, cx: 1, cy: 2 });
  for (const bad of [
    null,
    "milagre:artifact-escape",
    { t: "press", x: "1" },
    { t: "pin", sx: 1, sy: 1 },
    { t: "eval", code: "x" },
    { t: "size", sw: Infinity, cw: 1 },
  ])
    assert.equal(readPageMessage(bad), null, JSON.stringify(bad));
});

test("the phone's designs canvas runs only its own script, and the designs run none", () => {
  const page = designsCanvasShell("#1c1c1e");
  const hash = createHash("sha256").update(DESIGNS_CANVAS_SCRIPT).digest("base64");
  assert.ok(page.includes(`script-src 'sha256-${hash}'`), "the policy allows the canvas script by its hash");
  assert.doesNotMatch(page, /script-src 'unsafe-inline'/, "and no other script");
  assert.match(page, /frame-src 'none'/);
  assert.match(page, /background:#1c1c1e/);
  assert.equal(page.match(/<script>/g)?.length, 1, "the page runs the canvas script only");
  assert.ok(page.includes(`<script>${DESIGNS_CANVAS_SCRIPT}</script>`));
  assert.doesNotMatch(DESIGNS_CANVAS_SCRIPT, /<\/script/i);
  // Each design's frame is made by the script, sandboxed with no permissions: the design runs no script of its own.
  assert.match(DESIGNS_CANVAS_SCRIPT, /setAttribute\("sandbox",""\)/);
  assert.doesNotMatch(DESIGNS_CANVAS_SCRIPT, /allow-scripts|allow-same-origin/);
  assert.match(designsCanvasShell("red;}body{x:y"), /background:#f2f2f2/, "only a plain color reaches the style");
});

test("the phone's designs canvas stops loaded placeholders with fully drawn strokes for their fade", () => {
  const page = designsCanvasShell();
  assert.ok(page.includes(".board.ready .draw{opacity:0}"), "loaded placeholders still fade out");
  assert.match(page, /\.draw\{[^}]*transition:opacity \.2s\}/, "the placeholder keeps its opacity transition");
  assert.match(DESIGNS_CANVAS_SCRIPT, /classList\.add\("ready"\)/, "loading a design stops its placeholder");
  assert.match(DESIGNS_CANVAS_SCRIPT, /classList\.remove\("ready"\)/, "a new version restarts its placeholder");
  assert.ok(page.includes(".board.ready .draw *{animation:none;stroke-dashoffset:0}"), "ready boards stop drawing with the whole icon visible");
  assert.ok(page.includes(".draw *{stroke-dasharray:100;stroke-dashoffset:100;animation:draw 1.8s ease-in-out infinite}"), "loading boards still animate");
  assert.ok(
    page.includes("@media (prefers-reduced-motion:reduce){.draw *{animation:none;stroke-dashoffset:0}"),
    "reduced motion keeps loading placeholders static",
  );
});

test("resolutions are read again only when a comment resolves or feedback is sent", () => {
  const home = { id: "home", version: 1, title: "Home" };
  const feedback = designFeedbackMessage({ comments: [{ design: home, text: "Bigger", id: newCommentId() }] });
  const steps = [
    { title: "Read a file", status: "done" },
    { title: RESOLVED_STEP, status: "running" },
  ];
  const before = designActivity(steps, ["hi", feedback]);
  assert.equal(
    designActivity([...steps, { title: "Edited a file", status: "done" }], ["hi", feedback, "more"]),
    before,
    "other steps and messages don't count",
  );
  assert.equal(designActivity([steps[0]!, { title: RESOLVED_STEP, status: "done" }], ["hi", feedback]), before + 1);
  assert.equal(designActivity(steps, ["hi", feedback, feedback]), before + 1);
  assert.match(newCommentId(), /^[a-f0-9]{8}$/);
  assert.deepEqual(
    [
      ...resolutionNotes([
        { id: "a", design: home, text: "x", createdAt: 1, resolved: { note: "Done", at: 2 } },
        { id: "b", design: home, text: "y", createdAt: 1 },
      ]),
    ],
    [["a", "Done"]],
  );
});

test("HTML feedback requests in-place Artifact edits without design versions or design-tool instructions", () => {
  const comment = {
    id: "1234abcd",
    design: { id: "explanation", title: "How it works", version: 7, format: "html" as const },
    text: "Explain the final step",
    x: 0.2,
    y: 0.3,
  };
  const message = designFeedbackMessage({ comments: [comment] });
  assert.match(message, /On the artifact "How it works" \(explanation\)/);
  assert.match(message, /artifact_read.*artifact_show/);
  assert.doesNotMatch(message, /version|design_read|design_apply/);
  const parsed = parseDesignFeedback(message)!;
  assert.equal(parsed.comments[0].design.format, "html");
  assert.equal(parsed.comments[0].text, comment.text);
  assert.equal(parsed.comments[0].id, comment.id);
  assert.equal(designFeedbackText(parsed), "How it works: Explain the final step");
});

test("designGroups lays designs out one row per group, in the order each group first appears", () => {
  const rows = designGroups([
    { id: "a", group: "Onboarding" },
    { id: "b" },
    { id: "c", group: "Settings" },
    { id: "d", group: "Onboarding" },
    { id: "e", group: " " },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.group, row.designs.map((design) => design.id)]),
    [
      ["Onboarding", ["a", "d"]],
      [null, ["b", "e"]],
      ["Settings", ["c"]],
    ],
  );
  assert.deepEqual(designGroups([]), []);
});

test("a comment on a tab names the tab, reads back with it, and pins sit on their own tab", () => {
  const comment = {
    design: { id: "report", version: 1, title: "Report", format: "html" as const },
    x: 0.1,
    y: 0.2,
    tab: { id: "data", title: "Raw data" },
    near: "Totals",
    id: "1234abcd",
    text: "Add units",
  };
  const message = designFeedbackMessage({ comments: [comment] });
  assert.match(message, /On the artifact "Report" \(report\), 10% across and 20% down, on the tab data \("Raw data"\), near "Totals": Add units/);
  assert.deepEqual(parseDesignFeedback(message)?.comments, [comment]);

  const page = {
    title: "Report",
    html: "<p>A</p>",
    tabs: [
      { id: "overview", title: "Overview", html: "<p>A</p>" },
      { id: "data", title: "Raw data", html: "<p>B</p>" },
    ],
  };
  assert.equal(artifactTab(page, "data").html, "<p>B</p>");
  assert.equal(artifactTab(page, "gone").id, "overview");
  assert.deepEqual(artifactTab({ title: "One", html: "<p>One</p>" }), { id: "", title: "One", html: "<p>One</p>" });
  assert.equal(onArtifactTab(comment, page, page.tabs[1]!), true);
  assert.equal(onArtifactTab(comment, page, page.tabs[0]!), false);
  assert.equal(onArtifactTab({}, page, page.tabs[0]!), true, "a pin from before tabs sits on the first");
  assert.equal(onArtifactTab({}, { title: "One", html: "" }, artifactTab({ title: "One", html: "" })), true);
});
