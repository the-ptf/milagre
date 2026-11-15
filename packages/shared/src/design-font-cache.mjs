import { ipcErrorMessage } from "./result.mjs";

export function createDesignFontReader(get) {
  const fonts = new Map();
  let unsupported = false;
  let generation = 0;
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
    const css = artifact.fontCss || fonts.get(artifact.fontKey);
    if (!css || !/<\/head>/i.test(artifact.html)) return get({ ...request, version: artifact.version });
    fonts.delete(artifact.fontKey);
    fonts.set(artifact.fontKey, css);
    while (fonts.size > 8) fonts.delete(fonts.keys().next().value);
    return { ...artifact, fontCss: css };
  }
  const read = (request) => load(request);
  read.reconnect = () => {
    generation++;
    unsupported = false;
  };
  return read;
}

export function restoreDesignFonts(artifact) {
  if (artifact.format !== "design" || !artifact.fontKey || !artifact.fontCss) return artifact;
  const { fontKey: _fontKey, fontCss, ...full } = artifact;
  const at = full.html.toLowerCase().indexOf("</head>");
  if (at < 0) return artifact;
  return { ...full, html: `${full.html.slice(0, at)}<style>${fontCss}</style>${full.html.slice(at)}` };
}
