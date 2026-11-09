// Opt-in real-provider comparison. Uses only temporary Projects and the user's existing sign-ins.
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { parseArgs } = require("node:util");
const { providerSettings, startHarness, summarizedTurn } = require("./live-design-harness.cjs");
const { designDiagnostics, applyDesignOperations, designLayout, designTextLayout } = require("@milagre/shared/design");
const { renderDesignPng, designRasterTesting } = require("../packages/core/src/design-raster.cjs");
const BRIEF = `Create an editable phone screen daily-notes titled Daily notes, 390 by 844, for a calm walking journal. Read the project kit first. If missing, save the default project kit with title Fieldnotes, colors paper #f6f4ef, ink #16261f, accent #27634b, textStyles title {fontSize:34,fontWeight:700} and body {fontSize:17,fontWeight:400}, spacing md 16 and sm 8, radii button 12. Pin that exact kit on the screen. Include heading text A quieter day, subtitle text One step at a time, meaningful real content and two linked button instances with distinct labels Start a walk and View history via componentProperties/componentValues. Give the title layer id heading and subtitle layer id subtitle. Use bound typography and spacing. Inspect the returned image and fix clipped text, overflow and low contrast before replying. Preserve this identity. Use design tools only, no HTML, research or other apps. The bundled design skill is available; read it if needed. Do not use extra process skills. Reply in one short sentence.`;
async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      strict: { type: "boolean", default: false },
      runs: { type: "string", default: "2" },
      output: { type: "string" },
      "codex-model": { type: "string" },
      "claude-model": { type: "string" },
    },
  });
  if (!values.live) {
    console.log("Opt-in provider evaluation. Use --live; consumes existing Codex and Claude account usage.");
    return;
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw Error("runs must be 1 to 5");
  const brief =
    BRIEF +
    (values.strict
      ? " Enable consistency.mode strict from the first save. Do not add exceptions, change the kit, or disable strict mode. Use only the declared palette, typography, spacing and radii. Prefer hug text and automatic vertical layout."
      : "");
  const output = path.resolve(values.output ?? "/tmp/milagre-design-eval");
  await fs.mkdir(output, { recursive: true });
  const report = {
    date: new Date().toISOString(),
    brief,
    strict: values.strict,
    runs,
    settings: [],
    samples: [],
    limitations: [
      "Small sample; not a statistical model ranking.",
      "Deterministic criteria and manual visual review are separate.",
      "Claude token accounting includes cache fields; provider accounting is not assumed identical.",
    ],
  };
  for (const provider of ["codex", "claude"]) {
    try {
      report.settings.push({ ...(await providerSettings({ provider, model: values[`${provider}-model`], effort: "low" })), evaluation: true });
    } catch (error) {
      report.samples.push({ provider, status: "unavailable", error: error.message });
    }
  }
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2));
  for (let run = 1; run <= runs; run++)
    for (const settings of report.settings) {
      const sample = { provider: settings.provider, model: settings.model, run, turns: [], checks: [] };
      report.samples.push(sample);
      let fixture;
      try {
        console.log(`Run ${run}: ${settings.provider} ${settings.model}`);
        const other = report.settings.find((s) => s.provider !== settings.provider);
        fixture = await startHarness(settings, other ? [other] : []);
        const created = await fixture.turn("create", brief);
        sample.turns.push(summarizedTurn(created));
        let first = await fixture.artifact("daily-notes");
        assert.equal(first.document.kit?.id, "project");
        assert.equal(first.document.kit?.version, 1);
        if (values.strict) assert.equal(first.document.consistency?.mode, "strict");
        assert.ok(first.document.nodes.some((n) => n.componentProperties));
        assert.ok(first.document.nodes.some((n) => n.componentValues));
        sample.diagnostics = designDiagnostics(first.document);
        sample.quality = {
          kitDriftWarnings: sample.diagnostics.warnings.filter((w) => w.kind === "kit-drift").length,
          layoutAndContrastWarnings: sample.diagnostics.warnings.filter((w) => ["clipped-text", "overflow", "off-canvas", "low-contrast"].includes(w.kind))
            .length,
          creationWrites: created.tools.filter((t) => ["design_show", "design_apply"].includes(t.name)).length,
        };
        sample.checks.push("Pinned project kit and component property instances");
        const png = await renderDesignPng(first.document);
        await fs.writeFile(path.join(output, `${settings.provider}-${run}.png`), Buffer.from(png.base64, "base64"));
        await fs.writeFile(path.join(output, `${settings.provider}-${run}.json`), JSON.stringify(first.document, null, 2));
        const manual = await fixture.edit(first.id, first.version, [
          { op: "update", id: "subtitle", patch: { text: "My own words" } },
          { op: "insert", node: { id: "review-marker", type: "ellipse", x: 335, y: 25, width: 30, height: 30, fill: "#e11d48" } },
          ...(values.strict
            ? [
                {
                  op: "document",
                  patch: {
                    consistency: {
                      mode: "strict",
                      exceptions: [{ nodeId: "review-marker", field: "fill", value: "#e11d48", reason: "Evaluation marker deliberately added by the user" }],
                    },
                  },
                },
              ]
            : []),
        ]);
        const vision = await fixture.turn(
          "vision",
          "I added a review marker near the top-right. Call design_inspect on daily-notes, then describe only the marker's color and shape from the image. Do not call design_read or export. Do not change the design.",
        );
        sample.turns.push(summarizedTurn(vision));
        sample.vision = {
          answer: vision.assistantText,
          inspected: vision.tools.some((t) => t.name === "design_inspect"),
          readSource: vision.tools.some((t) => ["design_read", "design_export"].includes(t.name)),
        };
        assert.equal(sample.vision.inspected, true, "Vision turn must inspect the rendered image");
        assert.equal(sample.vision.readSource, false, "Vision turn must not read the source document");
        assert.equal((await fixture.artifact(first.id)).version, manual.version);
        const revised = await fixture.turn(
          "revise",
          "I edited the subtitle myself. Inspect and read daily-notes, then use design_apply to change only heading.text to A better morning. Preserve every other property, layer, id, the pinned kit, both button labels and my subtitle. Do not use design_show. Reply briefly.",
        );
        sample.turns.push(summarizedTurn(revised));
        let latest = await fixture.artifact(first.id);
        assert.deepEqual(latest.document, applyDesignOperations(manual.document, [{ op: "update", id: "heading", patch: { text: "A better morning" } }]));
        sample.checks.push("Inspection does not save", "Revision preserves user edit and every unrelated property");
        await assert.rejects(fixture.edit(first.id, manual.version, [{ op: "update", id: "heading", patch: { text: "Stale" } }]), /version conflict/i);
        sample.checks.push("Stale write rejected");
        const beforeContent = await fixture.artifact(first.id);
        const longText = "A quieter morning begins with a longer walk through the neighborhood";
        const contentOnly = await fixture.turn(
          "content-only",
          `Change only heading.text to "${longText}". Preserve every other field and all user edits. Inspect after saving. If the new text clips or overflows, tell me explicitly without adjusting other fields.`,
        );
        sample.turns.push(summarizedTurn(contentOnly));
        const afterContent = await fixture.artifact(first.id);
        assert.deepEqual(afterContent.document, applyDesignOperations(beforeContent.document, [{ op: "update", id: "heading", patch: { text: longText } }]));
        sample.contentOnly = { diagnostics: designDiagnostics(afterContent.document), answer: contentOnly.assistantText };
        sample.checks.push("Content-only edit preserves every unrelated field");
        const fit = await fixture.turn(
          "fit-content",
          "Now accommodate that longer heading: adjust only the necessary geometry or sizing/layout settings so all visible text fits and heading/subtitle do not overlap. Preserve all copy, colors, typography, ids, component links, the pinned kit, strict mode and my edits. Do not add exceptions or remove layers. Preflight and inspect after saving.",
        );
        sample.turns.push(summarizedTurn(fit));
        const fitted = await fixture.artifact(first.id);
        const geometry = new Set(["x", "y", "width", "height", "widthMode", "heightMode", "minWidth", "minHeight", "layout", "align", "justify"]);
        const withoutGeometry = (document) => ({
          ...document,
          nodes: document.nodes.map((n) => Object.fromEntries(Object.entries(n).filter(([field]) => !geometry.has(field)))),
        });
        assert.deepEqual(withoutGeometry(fitted.document), withoutGeometry(afterContent.document));
        const diagnostics = designDiagnostics(fitted.document);
        assert.equal(
          diagnostics.warnings.filter((w) => ["clipped-text", "overflow", "off-canvas", "low-contrast", "kit-drift"].includes(w.kind)).length,
          0,
          "Fitted screen must have no layout, contrast or kit drift warnings",
        );
        const bounds = designLayout(fitted.document, designTextLayout);
        const heading = bounds.get("heading"),
          subtitle = bounds.get("subtitle");
        assert.ok(
          heading.y + heading.height <= subtitle.y ||
            subtitle.y + subtitle.height <= heading.y ||
            heading.x + heading.width <= subtitle.x ||
            subtitle.x + subtitle.width <= heading.x,
          "Heading and subtitle must not overlap",
        );
        sample.fitted = { diagnostics, answer: fit.assistantText };
        const fittedPng = await renderDesignPng(fitted.document);
        await fs.writeFile(path.join(output, `${settings.provider}-${run}-fitted.png`), Buffer.from(fittedPng.base64, "base64"));
        await fs.writeFile(path.join(output, `${settings.provider}-${run}-fitted.json`), JSON.stringify(fitted.document, null, 2));
        sample.checks.push("Fit-content changes only geometry and clears layout defects");
        latest = fitted;
        if (other) {
          const takeover = await fixture.turn(
            "takeover",
            "Take over the daily-notes design. Read its pinned kit and inspect/read the current screen. Change only heading.text to Tomorrow starts here with design_apply, preserving all other layers and user edits. Do not create a new design. Reply briefly.",
            300000,
            other,
          );
          sample.turns.push(summarizedTurn(takeover));
          assert.deepEqual(
            (await fixture.artifact(first.id)).document,
            applyDesignOperations(latest.document, [{ op: "update", id: "heading", patch: { text: "Tomorrow starts here" } }]),
          );
          sample.checks.push(`Takeover by ${other.provider} preserves all unrelated fields`);
        }
        sample.status = "passed";
        sample.quality.status = sample.diagnostics.warnings.length ? "review-needed" : "no-warnings";
      } catch (error) {
        sample.status = "failed";
        sample.error = error.message;
        if (error.turn) sample.turns.push(error.turn);
        console.log(`${sample.provider}: ${error.message}`);
      } finally {
        await fixture?.close();
        await fs.writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2));
      }
    }
  designRasterTesting.retire();
  console.log(`Results: ${output}/results.json`);
  if (report.samples.some((s) => s.status !== "passed")) process.exitCode = 1;
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { BRIEF };
