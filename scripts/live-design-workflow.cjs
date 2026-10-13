// Opt-in: node scripts/live-design-workflow.cjs --live [--model ID] [--effort low] [--output /tmp/results.json]
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { providerSettings, startHarness, summarizedTurn } = require("./live-design-harness.cjs");

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      model: { type: "string" },
      effort: { type: "string" },
      output: { type: "string" },
      "allow-skill-read": { type: "string", multiple: true },
    },
  });
  if (!values.live) {
    console.log("Opt-in real-provider check. Run with --live; it uses the existing Codex sign-in and consumes provider usage.");
    return;
  }
  const settings = await providerSettings({ ...values, allowedSkillReads: values["allow-skill-read"] });
  const fixture = await startHarness(settings);
  const results = {
    date: new Date().toISOString(),
    settings,
    isolation:
      "Temporary git Project and Milagre profile; ephemeral Codex thread; external MCPs disabled; existing sign-in reused without copying credentials.",
    checks: [],
    turns: [],
  };
  const output = values.output ? path.resolve(values.output) : path.join(fixture.root, "workflow-results.json");
  try {
    console.log(`Live workflow: ${settings.model}, ${settings.effort} effort.`);
    const created = await fixture.turn(
      "create",
      "Create an editable phone design with milagre design_show, id daily-notes, title Daily notes. Use a 390 by 844 screen with a warm off-white background. Include a text layer with id heading and text A quieter day, a text layer with id subtitle and text One step at a time, and a rounded button frame with id start-button and a text label Start a walk. Give layers meaningful names and sensible sizes/spacing. Use the design tool, no HTML, files, research, other apps or questions. After the tool succeeds, reply with one short sentence.",
    );
    results.turns.push(summarizedTurn(created));
    assert.ok(created.tools.some((tool) => tool.name === "design_show" && !tool.error));
    const first = await fixture.artifact("daily-notes");
    assert.equal(first.format, "design");
    assert.equal(first.version, 1);
    assert.ok(created.cards.some((card) => card.id === first.id && card.version === 1));
    const userEdit = await fixture.edit(first.id, 1, [{ op: "update", id: "subtitle", patch: { text: "My own words" } }]);
    assert.equal(userEdit.version, 2);
    await assert.rejects(fixture.edit(first.id, 1, [{ op: "update", id: "subtitle", patch: { text: "Stale overwrite" } }]), /version conflict/i);
    results.checks.push("Real provider created version 1 and its Chat card", "Manual artifact:apply created version 2", "Stale version 1 edit was rejected");
    console.log("Created version 1; manual edit saved version 2; stale edit rejected.");
    const revised = await fixture.turn(
      "revise",
      "Revise daily-notes. I edited the subtitle myself while you were away. Read its latest source with milagre design_read, then use milagre design_apply with the returned version to change only heading.text to A better morning and heading.fontSize to 34. Preserve every other layer and property, especially my subtitle. Do not use design_show or HTML. Finish with one short sentence.",
    );
    results.turns.push(summarizedTurn(revised));
    const names = revised.tools.map((tool) => tool.name);
    assert.ok(names.indexOf("design_read") >= 0 && names.indexOf("design_read") < names.indexOf("design_apply"));
    assert.ok(revised.tools.some((tool) => tool.name === "design_apply" && tool.arguments.expectedVersion === 2 && !tool.error));
    const latest = await fixture.artifact(first.id);
    assert.equal(latest.version, 3);
    assert.equal(latest.document.nodes.find((node) => node.id === "subtitle").text, "My own words");
    assert.equal(latest.document.nodes.find((node) => node.id === "heading").text, "A better morning");
    const expected = {
      ...userEdit.document,
      nodes: userEdit.document.nodes.map((node) => (node.id === "heading" ? { ...node, text: "A better morning", fontSize: 34 } : node)),
    };
    assert.deepEqual(latest.document, expected);
    assert.deepEqual((await fixture.artifact(first.id, 1)).document, first.document);
    assert.ok(revised.cards.some((card) => card.id === first.id && card.version === 3));
    results.checks.push(
      "Agent read version 2 and applied a small batch against it",
      "Version 3 preserves the manual subtitle and all unrelated properties",
      "Version 1 remains immutable",
      "The revision produced a version 3 Chat card",
    );
    results.status = "passed";
    console.log("Agent read version 2, saved version 3, and preserved the manual edit and version 1.");
  } catch (error) {
    results.status = "failed";
    results.error = error.message;
    process.exitCode = 1;
    if (error.turn) results.turns.push(error.turn);
    console.error(error.message);
  } finally {
    await fixture.close();
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
    console.log(`Results: ${output}`);
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
