#!/usr/bin/env node
// Independent inspection of immutable model outputs. Never counts its own previews as model work.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const WORKTREE = path.resolve(__dirname, "../..");
const combinations = (narrowWidth = 375) => [
  [720, "light"],
  [720, "dark"],
  [narrowWidth, "light"],
  [narrowWidth, "dark"],
];
const DIMENSIONS = ["correctness", "legibility", "responsiveness", "interaction", "integration"];
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const missing = (values, narrowWidth) =>
  combinations(narrowWidth)
    .map(([width, theme]) => `${width}/${theme}`)
    .filter((value) => !values.includes(value));

function options(args) {
  const result = { reportOnly: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error("--out needs a directory");
      result.out = path.resolve(args[++i]);
    } else if (args[i] === "--reviews") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error("--reviews needs a file");
      result.reviews = path.resolve(args[++i]);
    } else if (args[i] === "--report-only") result.reportOnly = true;
    else throw Error(`Unknown argument: ${args[i]}`);
  }
  if (!result.out) throw Error("Usage: node scripts/html-eval/inspect.cjs --out <run-directory> [--reviews <json>] [--report-only]");
  return result;
}

function before(preview, render) {
  const end = Date.parse(preview.finishedAt);
  const start = Date.parse(render?.startedAt);
  return !preview.isError && Number.isFinite(end) && Number.isFinite(start) && end <= start;
}

function coverage(calls, final, narrowWidth = 375) {
  const previews = calls.filter((c) => c.tool === "html_preview");
  const key = (c) => `${c.input?.width ?? 720}/${c.input?.appearance ?? "light"}`;
  const anyHtml = [...new Set(previews.filter((c) => !c.isError && c.finishedAt).map(key))];
  const exact = final ? previews.filter((c) => c.htmlSha256 === final.htmlSha256 && before(c, final)) : [];
  const finalHtml = [...new Set(exact.map(key))];
  return {
    anyHtml,
    missingAnyHtml: missing(anyHtml, narrowWidth),
    finalHtml,
    missingFinalHtml: missing(finalHtml, narrowWidth),
    finalHtmlPreviewedBeforeRender: exact.length > 0,
    narrowWidth,
    widthNarrow: exact.some((c) => (c.input?.width ?? 720) === narrowWidth),
    width340: exact.some((c) => (c.input?.width ?? 720) === 340),
    width375: exact.some((c) => (c.input?.width ?? 720) === 375),
    width720: exact.some((c) => (c.input?.width ?? 720) === 720),
    anyDark: exact.some((c) => c.input?.appearance === "dark"),
    fullQaMatrix: missing(finalHtml, narrowWidth).length === 0,
    rule: "A successful preview of the exact final SHA must finish before that render starts.",
  };
}

function storedFiles(directory, id) {
  if (!id || !fs.existsSync(directory)) return [];
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (path.basename(path.dirname(file)) === id && entry.name.endsWith(".html")) files.push(file);
    }
  }
  walk(directory);
  return files;
}

function loadReview(file) {
  if (!fs.existsSync(file)) return { version: 1, sessions: {} };
  const reviews = readJson(file);
  if (reviews.version !== 1 || !reviews.sessions || Array.isArray(reviews.sessions))
    throw Error("Reviews must contain {version:1,sessions:{<sessionId>:<review>}}");
  for (const [id, review] of Object.entries(reviews.sessions)) {
    if (!review || typeof review !== "object") throw Error(`Invalid review: ${id}`);
    if (!review.reviewer || review.reviewer.startsWith("REPLACE_") || !Array.isArray(review.evidence) || !review.evidence.length)
      throw Error(`Review ${id} needs reviewer and evidence paths`);
    if (!review.htmlSha256 || !/^[a-f0-9]{64}$/.test(review.htmlSha256)) throw Error(`Review ${id} needs exact htmlSha256`);
    for (const key of DIMENSIONS) {
      const value = review.scores?.[key];
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 4)) throw Error(`Review ${id}: ${key} must be 0..4 or null (untested)`);
    }
    if (!Array.isArray(review.findings)) throw Error(`Review ${id} needs findings array`);
    for (const finding of review.findings) {
      if (!["renderer", "generated-html", "instructions", "harness", "unknown"].includes(finding.attribution))
        throw Error(`Review ${id} finding needs attribution`);
      if (!finding.evidence || !finding.description) throw Error(`Review ${id} finding needs description and evidence`);
    }
  }
  return reviews;
}

async function inspect(root) {
  const { previewHtml } = require(path.join(WORKTREE, "packages/core/src/html-render.cjs"));
  const manifestFile = path.join(root, "manifest.json");
  const frozenManifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : {};
  const narrowWidth = frozenManifest.previewNarrowWidth ?? 375;
  if (!Number.isInteger(narrowWidth) || narrowWidth < 240 || narrowWidth > 1600) throw Error("Invalid manifest previewNarrowWidth");
  const sessionsDir = path.join(root, "sessions");
  if (!fs.existsSync(sessionsDir)) throw Error(`No sessions directory: ${sessionsDir}`);
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    worktree: WORKTREE,
    note: `Inspection screenshots are independent post-generation checks, not model previews. A ${narrowWidth}px Chromium page is not a native-mobile test.`,
    inspectionSource: Object.fromEntries(
      ["packages/core/src/html-render.cjs", "packages/shared/src/html-render.mjs"].map((name) => [name, sha(fs.readFileSync(path.join(WORKTREE, name)))]),
    ),
    sessions: [],
  };
  for (const dirent of fs.readdirSync(sessionsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory() || dirent.name.startsWith("_")) continue;
    const sid = dirent.name;
    const dir = path.join(sessionsDir, sid);
    const entry = { sessionId: sid, status: "error", errors: [], final: null };
    index.sessions.push(entry);
    try {
      const meta = readJson(path.join(dir, "session.json"));
      const calls = fs.existsSync(path.join(dir, "calls.json")) ? readJson(path.join(dir, "calls.json")) : [];
      Object.assign(entry, {
        caseId: meta.caseId,
        repeat: meta.repeat,
        prompt: meta.prompt,
        model: { requested: meta.model, init: meta.init?.model, responses: meta.responseModels },
        exit: meta.exit,
        result: meta.result && {
          subtype: meta.result.subtype,
          is_error: meta.result.is_error,
          num_turns: meta.result.num_turns,
          duration_ms: meta.result.duration_ms,
          total_cost_usd: meta.result.total_cost_usd,
        },
        startedAt: meta.startedAt,
        finishedAt: meta.finishedAt,
        files: {
          session: path.join(dir, "session.json"),
          calls: path.join(dir, "calls.json"),
          transcript: path.join(dir, "transcript.jsonl"),
          finalReply: path.join(dir, "final-reply.md"),
        },
        calls: calls.map((c) => ({
          seq: c.seq,
          tool: c.tool,
          startedAt: c.startedAt,
          finishedAt: c.finishedAt,
          input: c.input,
          htmlFile: c.htmlFile,
          htmlSha256: c.htmlSha256,
          isError: c.isError,
          error: c.error,
          consoleMessages: c.output?.parsed?.consoleMessages,
          screenshot: c.output?.images?.[0]?.file,
        })),
        toolErrors: calls.filter((c) => c.isError).map((c) => ({ seq: c.seq, tool: c.tool, error: c.error })),
      });
      if (!meta.finishedAt || !meta.exit) {
        entry.status = "incomplete";
        entry.errors.push("Session has not settled; not inspected.");
        continue;
      }
      if (meta.exit.code !== 0 || meta.result?.is_error || meta.status === "failed")
        entry.errors.push(`Generation failed: exit=${meta.exit.code}, result=${meta.result?.subtype}`);
      const final = calls
        .filter((c) => c.tool === "html_render" && !c.isError && c.finishedAt)
        .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))
        .at(-1);
      entry.modelPreviewCoverage = coverage(calls, final, narrowWidth);
      if (!final) {
        entry.errors.push("No successful final html_render.");
        continue;
      }
      const html = fs.readFileSync(final.htmlFile, "utf8");
      const hash = sha(html);
      if (hash !== final.htmlSha256) {
        entry.errors.push("Final HTML file differs from recorded hash; refusing inspection.");
        continue;
      }
      const out = path.join(root, "inspection", sid);
      fs.mkdirSync(out, { recursive: true });
      const htmlFile = path.join(out, "final.html");
      if (fs.existsSync(htmlFile) && sha(fs.readFileSync(htmlFile)) !== hash) throw Error("Refusing to overwrite different inspected HTML.");
      fs.writeFileSync(htmlFile, html);
      fs.writeFileSync(path.join(out, "final-source.txt"), html);
      const stored = storedFiles(path.join(dir, "artifacts-store"), final.output?.parsed?.id);
      const storedMatchesModel = stored.length ? stored.every((file) => sha(fs.readFileSync(file)) === hash) : null;
      if (storedMatchesModel === false) entry.errors.push("Stored HTML differs from model HTML.");
      const screenshots = {};
      for (const [width, appearance] of combinations(narrowWidth)) {
        const key = `${width}-${appearance}`;
        try {
          const result = await previewHtml({ html, width, appearance });
          const file = path.join(out, `final-${key}.png`);
          fs.writeFileSync(file, Buffer.from(result.png, "base64"));
          screenshots[key] = {
            file,
            width,
            appearance,
            contentHeight: result.contentHeight,
            consoleMessages: result.consoleMessages,
            overflowX: result.overflowX,
            overflowSelector: result.overflowSelector,
            capturedAt: new Date().toISOString(),
          };
        } catch (error) {
          screenshots[key] = { error: error.message };
          entry.errors.push(`Inspection ${key}: ${error.message}`);
        }
      }
      entry.final = {
        renderCallSeq: final.seq,
        title: final.input?.title,
        height: final.input?.height,
        htmlSha256: hash,
        htmlBytes: Buffer.byteLength(html),
        htmlFile,
        sourceFile: path.join(out, "final-source.txt"),
        storedHtmlFiles: stored,
        storedMatchesModel,
        inspectionScreenshots: screenshots,
      };
      entry.status = entry.errors.length ? "error" : "generated";
    } catch (error) {
      entry.errors.push(error.message);
    }
    console.log(`${sid}: ${entry.status}; ${entry.errors.length} inspection/generation error(s)`);
    writeJson(path.join(root, "index.json"), index);
  }
  if (fs.existsSync(manifestFile)) {
    const manifest = readJson(manifestFile);
    index.manifest = {
      file: manifestFile,
      plannedSessions: manifest.sessionCount,
      finishedAt: manifest.finishedAt,
      sourcesUnchanged: manifest.sourcesUnchanged,
    };
    index.rendererMatchesGeneration = Object.entries(index.inspectionSource).every(([name, hash]) => manifest.sources?.[name] === hash);
    for (const spec of manifest.cases || [])
      for (let repeat = 1; repeat <= manifest.repeat; repeat++) {
        const sessionId = `${spec.id}-r${repeat}`;
        if (!index.sessions.some((s) => s.sessionId === sessionId))
          index.sessions.push({
            sessionId,
            caseId: spec.id,
            repeat,
            prompt: spec.prompt,
            status: manifest.finishedAt ? "error" : "incomplete",
            errors: ["Planned session has no output directory."],
            final: null,
          });
      }
  }
  writeJson(path.join(root, "index.json"), index);
  return index;
}

function report(index, reviews, root) {
  const rel = (file) => path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/");
  const summary = {
    dimensions: Object.fromEntries(DIMENSIONS.map((key) => [key, { untested: 0, counts: [0, 0, 0, 0, 0] }])),
    sessions: index.sessions.length,
    generated: 0,
    failed: 0,
    incomplete: 0,
    fullFinalPreviewCoverage: 0,
    reviewed: 0,
    costUsd: 0,
    consoleMessages: 0,
  };
  const cards = [];
  const markdown = [
    "# HTML generation evaluation",
    "",
    index.note,
    "",
    "Scores are reviewer assessment; missing or stale review is UNREVIEWED. Tool success does not imply visual quality.",
    "",
  ];
  for (const s of index.sessions) {
    summary[s.status === "generated" ? "generated" : s.status === "incomplete" ? "incomplete" : "failed"]++;
    summary.costUsd += s.result?.total_cost_usd ?? 0;
    if (s.final && s.modelPreviewCoverage?.missingFinalHtml?.length === 0) summary.fullFinalPreviewCoverage++;
    const candidate = reviews.sessions[s.sessionId];
    const review = candidate?.htmlSha256 === s.final?.htmlSha256 ? candidate : null;
    s.review = review || {
      status: "UNREVIEWED",
      reason: candidate ? "Review hash does not match final source." : "No review submitted.",
      scores: Object.fromEntries(DIMENSIONS.map((key) => [key, null])),
    };
    if (review) summary.reviewed++;
    for (const dimension of DIMENSIONS) {
      const score = review?.scores?.[dimension];
      if (score === null || score === undefined) summary.dimensions[dimension].untested++;
      else summary.dimensions[dimension].counts[score]++;
    }
    const shots = Object.entries(s.final?.inspectionScreenshots ?? {});
    summary.consoleMessages += shots.reduce((total, [, shot]) => total + (shot.consoleMessages?.length ?? 0), 0);
    const coverageText = s.modelPreviewCoverage?.finalHtml?.join(", ") || "none";
    markdown.push(
      `## ${s.sessionId}`,
      "",
      `Generation: ${s.status}. Reviewer assessment: ${review ? review.reviewer : "UNREVIEWED"}.`,
      `Exact final previews completed before render: ${coverageText}. Full four-way coverage is a QA criterion, not itself a tool instruction.`,
      "",
    );
    if (s.errors.length) markdown.push(...s.errors.map((error) => `- Error: ${error}`), "");
    if (review)
      markdown.push(
        `Scores (0–4; null = untested): ${JSON.stringify(review.scores)}`,
        ...review.findings.map((finding) => `- ${finding.attribution}: ${finding.description} (${finding.evidence})`),
        "",
      );
    const images = shots
      .map(([key, shot]) =>
        shot.file
          ? `<figure><a href="${esc(rel(shot.file))}"><img loading="lazy" src="${esc(rel(shot.file))}" alt="${esc(s.sessionId)} ${esc(key)}"></a><figcaption>${esc(key)} · ${shot.contentHeight}px · ${shot.consoleMessages?.length || 0} console messages</figcaption></figure>`
          : `<p>${esc(key)}: ${esc(shot.error)}</p>`,
      )
      .join("");
    cards.push(
      `<article><h2>${esc(s.sessionId)} · ${esc(s.final?.title || "No output")}</h2><p>${esc(s.prompt)}</p><p><b>${esc(s.status)}</b> · Review: <b>${esc(review ? review.reviewer : "UNREVIEWED")}</b> · Model final-preview coverage: ${esc(coverageText)}</p>${s.final ? `<p>SHA256: <code>${esc(s.final.htmlSha256)}</code> · <a href="${esc(rel(s.final.sourceFile))}">View source text</a> · stored bytes match: ${esc(s.final.storedMatchesModel)}</p>` : ""}<ul>${s.errors.map((error) => `<li>${esc(error)}</li>`).join("")}</ul>${review ? `<pre>${esc(JSON.stringify(review, null, 2))}</pre>` : "<p>Correctness, legibility, responsiveness, interaction and integration: UNREVIEWED.</p>"}<div class="shots">${images}</div></article>`,
    );
  }
  index.summary = summary;
  index.reportedAt = new Date().toISOString();
  writeJson(path.join(root, "index.json"), index);
  writeJson(path.join(root, "inspection-summary.json"), summary);
  fs.writeFileSync(
    path.join(root, "report.md"),
    markdown
      .slice(0, 6)
      .concat([JSON.stringify(summary, null, 2), ""], markdown.slice(6))
      .join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(root, "report.html"),
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';"><title>HTML generation eval</title><style>body{font:15px/1.5 system-ui;margin:24px;background:#f5f6f8;color:#18202b}h1,h2{line-height:1.2}article{background:white;padding:20px;margin:24px 0;border:1px solid #d9dde3;border-radius:10px}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px}figure{margin:0;border:1px solid #ccc;padding:8px}img{max-width:100%;height:auto;display:block}figcaption{padding-top:8px;color:#555}code,pre{overflow-wrap:anywhere;white-space:pre-wrap}a{color:#005bbb}</style><h1>HTML generation eval</h1><p>${esc(index.note)}</p><p>Independent inspection only. No scripts or generated HTML run inside this gallery.</p><pre>${esc(JSON.stringify(summary, null, 2))}</pre>${cards.join("")}`,
  );
  if (!fs.existsSync(path.join(root, "reviews.example.json")))
    writeJson(path.join(root, "reviews.example.json"), {
      version: 1,
      sessions: Object.fromEntries(
        index.sessions
          .filter((s) => s.final)
          .map((s) => [
            s.sessionId,
            {
              reviewer: "REPLACE_WITH_REVIEWER",
              htmlSha256: s.final.htmlSha256,
              evidence: ["REPLACE_WITH_SCREENSHOT_OR_INTERACTION_EVIDENCE"],
              scores: Object.fromEntries(DIMENSIONS.map((key) => [key, null])),
              findings: [],
              notes: "Not reviewed. Replace this template only after examining evidence.",
            },
          ]),
      ),
    });
  console.log(JSON.stringify(summary));
}

async function main(args = process.argv.slice(2)) {
  const config = options(args);
  const index = config.reportOnly ? readJson(path.join(config.out, "index.json")) : await inspect(config.out);
  const reviews = loadReview(config.reviews || path.join(config.out, "reviews.json"));
  report(index, reviews, config.out);
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { before, coverage, loadReview, report, inspect, options };
