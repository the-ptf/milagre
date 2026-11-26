const { designSystemNotes } = require("./design-system-notes.cjs");
const { z } = require("zod");
const { withDesignHost } = require("./design-host-fonts.cjs");

const DESIGN_MODE_INPUT = z
  .enum(["light", "dark", "contrast"])
  .optional()
  .describe("The color mode your image and warnings show, for a design whose tokens have dark or contrast values. Defaults to light.");

const designImplementation = () => withDesignHost(require("@milagre/shared/design"));

const MAX_SUMMARY_WARNINGS = 20;
const unbundledFamilies = (document) => {
  const families = new Set();
  for (const node of document.nodes) {
    if (
      node.type !== "text" ||
      node.hidden ||
      !node.fontFamily ||
      designImplementation().designUsesInter(node.fontFamily) ||
      designImplementation().designCatalogFont(node.fontFamily) ||
      designImplementation().designLocalFamily(node.fontFamily)
    )
      continue;
    const family = node.fontFamily
      .split(",")[0]
      .trim()
      .replace(/^["']|["']$/g, "");
    if (family) families.add(family);
  }
  return [...families];
};

const MAX_NAMED_LAYERS = 5;

function symbolNotes(document) {
  const design = designImplementation();
  const names = new Map();
  for (const node of document.nodes) {
    const name = node.type === "icon" && !node.hidden ? design.designSymbolName(node.icon) : null;
    if (name) names.set(name, names.get(name) ?? !!design.designSymbolImage(node));
  }
  if (!names.size) return [];
  const lucide = (list) => list.map((name) => `${name} → ${design.designSymbolLucide(name).icon}`).join(", ");
  if (!design.designSymbolsAvailable())
    return [`SF Symbols can't render on this computer, so they draw as their closest Lucide icon here and for the user: ${lucide([...names.keys()])}.`];
  const missing = [...names].filter(([, drawn]) => !drawn).map(([name]) => name);
  return [
    "SF Symbols render only in this computer's previews; a shared page draws the closest Lucide icon.",
    ...(missing.length
      ? [`This Mac has no SF Symbol named ${missing.join(", ")}; they draw as Lucide (${lucide(missing)}). Check the name in the SF Symbols app.`]
      : []),
  ];
}

function appleFamilies(document) {
  const design = designImplementation();
  const local = new Set();
  const missing = new Set();
  for (const node of document.nodes) {
    if (node.type !== "text" || node.hidden || !node.fontFamily || !design.designAppleFamily(node.fontFamily)) continue;
    const family = node.fontFamily.split(",")[0].trim();
    (design.designLocalFamily(node.fontFamily) ? local : missing).add(family);
  }
  const substitutes = (families) => [...new Set(families.map((family) => design.designFontSubstitute(family)))].join(", ");
  return { local: [...local], missing: [...missing], substitutes };
}

const undrawableTextLayers = (document) => {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const visible = (node) => {
    for (let depth = 0; node && depth < 64; depth++, node = byId.get(node.parentId)) if (node.hidden) return false;
    return true;
  };
  const ids = new Set();
  for (const node of document.nodes) {
    if (node.type !== "text" || !node.text || !visible(node)) continue;
    if ([...node.text].every(designImplementation().designInterHasGlyph)) continue;
    ids.add((designImplementation().designInstanceRoot(document, node.id, byId) ?? node).id);
  }
  return [...ids];
};

const namedLayers = (ids) =>
  ids
    .slice(0, MAX_NAMED_LAYERS)
    .map((id) => `"${id}"`)
    .join(", ") + (ids.length > MAX_NAMED_LAYERS ? ` and ${ids.length - MAX_NAMED_LAYERS} more` : "");

async function designFeedback(saved, source, { renderPng, warnings: findWarnings, intent, mode, notes: scope }) {
  const problems = [];
  let warnings = [];
  const document = mode ? designImplementation().designDocumentForMode(source, mode) : source;
  const modes = designImplementation().designModesOf(source);
  try {
    warnings = findWarnings(document);
  } catch (error) {
    problems.push(`Layout warnings could not be computed: ${error?.message ?? String(error)}.`);
  }
  const head = { ...saved, warnings: warnings.slice(0, MAX_SUMMARY_WARNINGS) };
  if (warnings.length > MAX_SUMMARY_WARNINGS) head.warningCount = warnings.length;
  const notes = [JSON.stringify(head)];
  let images = [];
  try {
    images = [await renderPng(document)];
    notes.push(
      intent?.mode === "text-only"
        ? "Look at the image. This was a text-only edit: report clipping, overflow or other warnings without changing geometry or style. Keep the same intent for further text edits; expanding the scope needs the user's permission."
        : intent?.mode === "fit-text"
          ? "Look at the image and verify the text fits. Keep this fit-text intent and its declared scope for any correction; preserve styles and other copy. Report problems that need a wider scope."
          : "Look at the image: check icons, spacing, alignment and density against the brief, fix what looks wrong and every item under Warnings within the user's requested scope with design_apply, then reply.",
    );
    if (modes.length > 1)
      notes.push(
        `This design switches between ${modes.join(", ")} modes; your image and the warnings show ${mode ?? "light"}. Check the others with design_inspect mode.`,
      );
    const fonts = unbundledFamilies(document);
    if (fonts.length) notes.push(`Your image shows ${fonts.join(", ")} in Inter; the user sees the real font.`);
    notes.push(...symbolNotes(document));
    const apple = appleFamilies(document);
    if (apple.local.length)
      notes.push(`${apple.local.join(", ")} render only in this computer's previews; a shared page draws ${apple.substitutes(apple.local)} instead.`);
    if (apple.missing.length)
      notes.push(
        `${apple.missing.join(", ")} aren't installed on this computer, so they are measured and drawn in ${apple.substitutes(apple.missing)} here and for the user.`,
      );
    const blank = undrawableTextLayers(document);
    if (blank.length)
      notes.push(`Your image can't draw some characters in ${namedLayers(blank)}; they are blank and the line may look cut there, but the user sees them.`);
  } catch (error) {
    notes.push(`The preview could not be rendered: ${error?.message ?? String(error)}. Check the warnings below.`);
  }
  notes.push(...problems);
  if (scope) notes.push(...(await designSystemNotes({ ...scope, id: saved.id, document: source, warnings }).catch(() => [])));
  const text = designImplementation().designWarningText(warnings.filter((warning) => warning.kind !== "remote-image"));
  if (text) notes.push(`Warnings:\n${text}`);
  const remote = designImplementation().designWarningText(warnings.filter((warning) => warning.kind === "remote-image"));
  if (remote) notes.push(`Notes:\n${remote}`);
  return { text: notes.join("\n"), images };
}

const DESIGN_CODE_STARTER = [
  '<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" integrity="sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z" crossorigin="anonymous"></script>',
  '<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" integrity="sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1" crossorigin="anonymous"></script>',
  '<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>',
].join("");
const INTERACTIVE_GUIDE = `For an interactive prototype (taps that change state, navigation between screens, tabs, forms, menus, animation), send html with width and height instead of document: one self-contained HTML page, run live in the viewers at that screen size. For React, load exactly ${DESIGN_CODE_STARTER} and write the app in <script type="text/babel">, rendering into a root element. Scripts load only from unpkg.com, cdn.jsdelivr.net, cdnjs.cloudflare.com or esm.sh, each at an exact version (Tailwind's browser build: https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.17); write the design's own code inline. The design runs sandboxed: no fetch, forms to servers, localStorage or cookies, so keep state in memory and use realistic sample data. Put a flow's screens in one design and switch them with state; set data-screen-label on each screen's root. Revise it with design_apply edits (exact text to find and its replacement), or design_show with the whole html.`;

async function interactiveFeedback(saved, html, { screenshot, crop }) {
  const notes = [JSON.stringify(saved)];
  let images = [];
  try {
    const shot = await screenshot({ html, width: saved.width, height: saved.height, crop });
    images = [{ mime: "image/png", base64: shot.png }];
    notes.push(
      "Look at the image: the design's first screen before anyone interacts. Check layout, spacing, type, icons and contrast against the brief, fix what looks wrong with design_apply edits, then reply.",
    );
    if (shot.blank) notes.push("The screen is blank: the design's scripts probably failed. Read the console below.");
    if (shot.contentWidth > saved.width + 1)
      notes.push(`The content is ${shot.contentWidth}px wide on a ${saved.width}px screen, so it scrolls sideways. Fix the overflow.`);
    if (shot.contentHeight > saved.height + 1) notes.push(`The content is ${shot.contentHeight}px tall on a ${saved.height}px screen; below that it scrolls.`);
    if (shot.consoleMessages.length) notes.push(`Console:\n${shot.consoleMessages.map((message) => `${message.level}: ${message.text}`).join("\n")}`);
  } catch (error) {
    notes.push(`The preview could not be drawn: ${error?.message ?? String(error)}. The design is saved and the user sees it.`);
  }
  return { text: notes.join("\n"), images };
}

/** design_inspect for a layer design: the image, plus bounds, diagnostics in the chosen mode and what the preview can't draw. */
async function inspectLayerDesign(saved, document, { renderPng, warnings, nodeId, mode }) {
  const design = designImplementation();
  await design.loadDesignFonts(document);
  const bounds = design.designLayout(document, design.designTextLayout);
  const crop = nodeId ? bounds.get(nodeId) : undefined;
  if (nodeId && !crop) throw Error(`Layer "${nodeId}" is missing or hidden.`);
  let diagnostics;
  try {
    diagnostics = { status: "checked", ...design.designDiagnostics(design.designDocumentForMode(document, mode)) };
  } catch (error) {
    diagnostics = { status: "failed", error: error.message };
  }
  const rendered = await designFeedback(saved, document, { warnings, mode, renderPng: (doc) => renderPng(doc, { crop }) });
  const preview = {
    renderer: "resvg",
    remoteImages: "placeholder",
    unbundledFonts: unbundledFamilies(document),
    undrawableText: undrawableTextLayers(document),
    crop,
  };
  const inspection = { version: saved.version, nodeId, mode: mode ?? "light", bounds: Object.fromEntries(bounds), diagnostics, preview };
  return { ...rendered, text: `${rendered.text}\n${JSON.stringify({ inspection })}` };
}

module.exports = { designFeedback, interactiveFeedback, inspectLayerDesign, unbundledFamilies, undrawableTextLayers, INTERACTIVE_GUIDE, DESIGN_MODE_INPUT };
