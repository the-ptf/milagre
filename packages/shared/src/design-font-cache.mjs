import { ipcErrorMessage } from "./result.mjs";

const LANES = 4;

/**
 * Reads designs with their embedded fonts split off: a reply carries `fontCss` only for a `fontKey` the reader doesn't
 * hold yet, and every design that shares a font shares one CSS string. The first read runs alone so the reads after it
 * already advertise its font, and at most `LANES` run at once, so a canvas opening many designs moves each font a few
 * times, not once per design.
 */
export function createDesignFontReader(get) {
  const fonts = new Map();
  let unsupported = false;
  let generation = 0;
  let running = 0;
  let primed = false;
  const waiting = [];
  function pump() {
    while (waiting.length && running < (primed ? LANES : 1)) {
      running++;
      waiting.shift()();
    }
  }
  function queued(task) {
    return new Promise((resolve, reject) => {
      waiting.push(() =>
        task()
          .then(resolve, reject)
          .finally(() => {
            running--;
            primed = true;
            pump();
          }),
      );
      pump();
    });
  }
  async function load(request) {
    const started = generation;
    if (unsupported) return get(request);
    let artifact;
    try {
      artifact = await get({ ...request, fonts: { have: [...fonts.keys()] } });
    } catch (error) {
      const message = ipcErrorMessage(error);
      if (!message.startsWith("Invalid arguments:") || !/\bfonts\b/.test(message)) throw error;
      const full = await get(request);
      if (started === generation) unsupported = true;
      return full;
    }
    if (artifact.format !== "design" || !artifact.fontKey) return artifact;
    const css = fonts.get(artifact.fontKey) ?? artifact.fontCss;
    if (!css || !/<\/head>/i.test(artifact.html)) return get({ ...request, version: artifact.version });
    fonts.delete(artifact.fontKey);
    fonts.set(artifact.fontKey, css);
    while (fonts.size > 8) fonts.delete(fonts.keys().next().value);
    return { ...artifact, fontCss: css };
  }
  const read = (request) => queued(() => load(request));
  read.reconnect = () => {
    generation++;
    unsupported = false;
  };
  return read;
}

/** The design's page with its fonts back in, for a frame that draws it. */
export function restoreDesignFonts(artifact) {
  if (artifact.format !== "design" || !artifact.fontKey || !artifact.fontCss) return artifact;
  const { fontKey: _fontKey, fontCss, ...full } = artifact;
  const at = full.html.toLowerCase().indexOf("</head>");
  if (at < 0) return artifact;
  return { ...full, html: `${full.html.slice(0, at)}<style>${fontCss}</style>${full.html.slice(at)}` };
}
