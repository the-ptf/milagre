// The landing hero's scene, "Dawn": the desktop app's first-launch intro (OnboardingIntro) drawn once at build time.
// A seeded generator keeps the stars and clouds in the same places on every build.

/** The logo's three shapes, as the app's StartupSplash draws them (viewBox -4 -4 154 154). */
export const MARK_LEFT =
  "M49.6983 66.5562L21.6836 116.174C19.802 119.507 22.2098 123.632 26.0372 123.632H39.9727L54.9727 100.132L66.9727 119.632L51.9727 144.132H26.0372C6.24066 144.132 -6.29344 122.89 3.27837 105.561L30.9405 55.4819L49.6983 66.5562Z";
export const MARK_RIGHT =
  "M142.666 105.561C152.238 122.89 139.704 144.132 119.907 144.132H93.9728L78.9728 119.632L90.9728 100.132L105.973 123.632H119.907C123.735 123.632 126.143 119.507 124.261 116.174L96.2462 66.5562L115.004 55.4819L142.666 105.561Z";
export const MARK_STAR =
  "M69.528 1.96636C71.0759 -0.655453 74.869 -0.655453 76.4169 1.96636L91.0103 26.6837C91.3538 27.2656 91.8392 27.751 92.4211 28.0945L117.138 42.6879C119.76 44.2358 119.76 48.0289 117.138 49.5768L92.4211 64.1702C91.8392 64.5137 91.3538 64.9991 91.0103 65.581L76.4169 90.2983C74.869 92.9201 71.0759 92.9201 69.528 90.2983L54.9347 65.581C54.5911 64.9991 54.1057 64.5137 53.5238 64.1702L28.8065 49.5768C26.1847 48.0289 26.1847 44.2358 28.8065 42.6879L53.5238 28.0945C54.1057 27.751 54.5911 27.2656 54.9347 26.6837L69.528 1.96636Z";

function seeded(seed: number) {
  return () => {
    seed = (Math.imul(seed ^ (seed >>> 15), seed | 1) + 0x6d2b79f5) | 0;
    return (seed >>> 0) / 4294967296;
  };
}
const round = (value: number) => Math.round(value * 10) / 10;

/** The night's stars, as percentages of the sky over the top 70% of the hero. */
export const STARS = (() => {
  const random = seeded(11);
  return Array.from({ length: 90 }, () => ({
    x: round(random() * 100),
    y: round(random() * 70),
    r: round((random() * 1.8 + 0.6) / 2),
    opacity: Math.round((0.35 + random() * 0.6) * 100) / 100,
  }));
})();

interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}
export interface CloudBank {
  /** The shaded underside, then the lit face on top of it. */
  shade: Ellipse[];
  face: Ellipse[];
  /** Where the solid floor starts, below the bank. */
  floor: number;
}

/** A bank of clouds across a band `width` wide: overlapping ellipses the noise filters in Clouds.astro roughen. */
function bank(width: number, { seed, count, top, bottom, scale }: { seed: number; count: number; top: number; bottom: number; scale: number }): CloudBank {
  const random = seeded(seed);
  const shade: Ellipse[] = [];
  const face: Ellipse[] = [];
  const span = Math.max(width, 900);
  for (let index = 0; index < count; index++) {
    const x = (index / (count - 1)) * width * 1.2 - width * 0.1 + (random() - 0.5) * width * 0.08;
    const y = top + (bottom - top) * random();
    const rx = (span * 0.09 + random() * span * 0.12) * scale;
    const ry = rx * (0.42 + random() * 0.2);
    shade.push({ cx: round(x), cy: round(y + ry * 0.35), rx: round(rx), ry: round(ry) });
    face.push({ cx: round(x - rx * 0.08), cy: round(y), rx: round(rx * 0.92), ry: round(ry * 0.9) });
  }
  return { shade, face, floor: bottom };
}

/** The cloud band under the apps and the download button, for wide windows and for phones. */
export const CLOUDS = {
  wide: {
    width: 1280,
    height: 240,
    soft: bank(1280, { seed: 4, count: 9, top: 100, bottom: 170, scale: 0.55 }),
    near: bank(1280, { seed: 9, count: 10, top: 150, bottom: 216, scale: 0.5 }),
  },
  narrow: {
    width: 390,
    height: 180,
    soft: bank(390, { seed: 4, count: 5, top: 44, bottom: 104, scale: 0.55 }),
    near: bank(390, { seed: 9, count: 5, top: 86, bottom: 146, scale: 0.5 }),
  },
};
