const { z } = require("zod");
const { designHostFonts, withDesignHostFonts } = require("./design-host-fonts.cjs");

const design = () => withDesignHostFonts(require("@milagre/shared/design"));
const fontFile = () => import("@milagre/shared/design-font-file");
const em = (value, unitsPerEm) => Math.round((value / unitsPerEm) * 1000) / 1000;

function metrics(info) {
  return {
    unitsPerEm: info.unitsPerEm,
    ascender: em(info.ascender, info.unitsPerEm),
    descender: em(info.descender, info.unitsPerEm),
    lineGap: em(info.lineGap, info.unitsPerEm),
    capHeight: info.capHeight ? em(info.capHeight, info.unitsPerEm) : null,
    xHeight: info.xHeight ? em(info.xHeight, info.unitsPerEm) : null,
  };
}

async function fontInfo(family, fonts = designHostFonts()) {
  const shared = design();
  const host = { platform: process.platform, appleFonts: !!(await fonts.info("SF Pro")) };
  const bundled = await shared.designBundledFont(family);
  if (bundled) {
    const { designFontFileInfo } = await fontFile();
    const info = designFontFileInfo(new Uint8Array(Buffer.from(bundled.faces[bundled.weights[0]], "base64")));
    return {
      family: bundled.family,
      available: true,
      source: "bundled",
      apple: false,
      variable: false,
      weights: bundled.weights.map((weight) => ({ weight })),
      styles: ["normal"],
      metrics: metrics(info),
      note: "Bundled with Milagre: measured and drawn the same everywhere, shared pages included.",
      host,
    };
  }
  const entry = await fonts.info(family);
  const substitute = shared.designFontSubstitute(family);
  if (!entry)
    return {
      family,
      available: false,
      source: "none",
      apple: shared.designAppleFamily(family),
      ...(substitute ? { substitute } : {}),
      note: substitute
        ? `Not installed on this computer: designs naming it measure and draw in ${substitute}.`
        : "Not installed on this computer: viewers draw the next family in the fontFamily list, measured with generic metrics.",
      host,
    };
  const sample = entry.faces[0];
  const variable = sample.axes.length > 0;
  return {
    family: entry.family,
    available: true,
    source: "installed",
    apple: entry.apple,
    variable,
    ...(variable ? { axes: sample.axes.map(({ tag, name, min, default: initial, max }) => ({ tag, name, min, default: initial, max })) } : {}),
    weights: entry.named.map((item) => ({ name: item.name, weight: item.weight })),
    styles: entry.styles,
    metrics: metrics(sample),
    ...(entry.opsz
      ? { opticalSize: entry.opsz.fixed ? `Pinned to ${entry.opsz.fixed}.` : `Follows fontSize from ${entry.opsz.min} to ${entry.opsz.max}.` }
      : {}),
    ...(entry.apple && substitute ? { substitute } : {}),
    note: entry.apple
      ? `Apple's font: it renders only in this computer's previews (canvas, phone, your image). Shared pages and computers without it draw ${substitute}.`
      : "Installed on this computer: it renders in this computer's previews; shared pages and other viewers draw it only if they have it installed.",
    host,
  };
}

function designFontToolDefinitions({ fonts } = {}) {
  return [
    {
      name: "design_font_info",
      description:
        "Look up a font for layer designs: whether Milagre bundles it, this computer has it installed (SF Pro, SF Pro Rounded, SF Compact, SF Mono and New York on a Mac) or neither, its real named weights (SF Pro Semibold is 590), styles, variation axes and vertical metrics, and what shared pages draw instead. Without family, lists the families available here. Text layers are measured with the real font, so use the weights it reports.",
      input: { family: z.string().min(1).max(160).optional().describe("A font family name, such as SF Pro or Inter.") },
      readOnly: true,
      run: async ({ family }) => {
        const source = fonts ?? designHostFonts();
        if (!family) {
          const installed = await source.families();
          return JSON.stringify({ bundled: ["Inter", ...design().DESIGN_CATALOG_FAMILIES], installed });
        }
        return JSON.stringify(await fontInfo(family, source));
      },
    },
  ];
}

module.exports = { designFontToolDefinitions, fontInfo };
