import { designFontFamily, designSvg, loadDesignFonts, type DesignDocument } from "@milagre/shared/design";

export type DesignExportFormat = "json" | "svg" | "png";
export type DesignExportItem = { id: string; title: string; document: DesignDocument };

export function designPageExportSize(designs: DesignExportItem[]) {
  const width = designs.reduce((sum, design) => sum + design.document.width, 0) + Math.max(0, designs.length - 1) * 80;
  const height = Math.max(1, ...designs.map((design) => design.document.height));
  const scale = Math.min(1, 4096 / Math.max(1, width, height));
  return { width, height, scale, pngWidth: Math.max(1, Math.ceil(width * scale)), pngHeight: Math.max(1, Math.ceil(height * scale)) };
}

function imageHost(source: string): string {
  try {
    return new URL(source).hostname || "an invalid URL";
  } catch {
    return "an invalid URL";
  }
}

function loadImage(source: string, crossOrigin = false): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (crossOrigin) image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    const timeout = window.setTimeout(() => {
      image.src = "";
      reject(new Error("An image took too long to load. Try again or use an embedded image."));
    }, 15000);
    image.addEventListener(
      "load",
      () => {
        clearTimeout(timeout);
        resolve(image);
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(
          new Error(
            crossOrigin
              ? `The image at ${imageHost(source)} could not be exported. Use an embedded image or a host that permits cross-origin image access.`
              : "An image could not be rendered for export.",
          ),
        );
      },
      { once: true },
    );
    image.src = source;
  });
}

/** SVG images must be inline before the SVG itself can be loaded as a raster image. */
async function pngSvg(document: DesignDocument): Promise<string> {
  const svg = new DOMParser().parseFromString(designSvg(document), "image/svg+xml");
  const sources = new Map<string, Promise<string>>();
  for (const element of svg.querySelectorAll("image")) {
    const source = element.getAttribute("href") ?? element.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (!source || !/^https:/i.test(source)) continue;
    if (!sources.has(source)) {
      sources.set(
        source,
        (async () => {
          const image = await loadImage(source, true);
          const scale = Math.min(1, 3840 / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("This device could not create a PNG. Download the SVG or JSON instead.");
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          try {
            return canvas.toDataURL("image/png");
          } catch {
            throw new Error(`The image at ${imageHost(source)} does not permit PNG export. Use an embedded image or download the SVG.`);
          }
        })(),
      );
    }
    const embedded = await sources.get(source)!;
    element.setAttribute("href", embedded);
    element.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", embedded);
  }
  await window.document.fonts.ready;
  await Promise.all(
    document.nodes
      .filter((node) => node.type === "text")
      .map(async (node) => {
        try {
          await window.document.fonts.load(`${node.fontWeight ?? 400} ${node.fontSize ?? 16}px ${designFontFamily(node.fontFamily)}`);
        } catch {
          // An unavailable font uses the same browser fallback as the SVG preview.
        }
      }),
  );
  return new XMLSerializer().serializeToString(svg);
}

async function designExportBlob(document: DesignDocument, format: DesignExportFormat, scale = 1): Promise<Blob> {
  if (format === "json")
    return new Blob([JSON.stringify(document, null, 2)], {
      type: "application/json",
    });
  // SVG and PNG embed the catalog families the design names.
  await loadDesignFonts(document);
  if (format === "svg") return new Blob([designSvg(document)], { type: "image/svg+xml" });
  const svg = URL.createObjectURL(new Blob([await pngSvg(document)], { type: "image/svg+xml" }));
  try {
    const image = await loadImage(svg);
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(document.width * scale));
    canvas.height = Math.max(1, Math.ceil(document.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This device could not create a PNG. Download the SVG or JSON instead.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The PNG could not be encoded. Download the SVG or JSON instead."))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(svg);
  }
}

/** Every artboard is exported together, preserving editable source in the page JSON. */
export async function designPageExportBlob(designs: DesignExportItem[], format: DesignExportFormat): Promise<Blob> {
  if (!designs.length) throw new Error("There are no designs to export.");
  if (format === "json") return new Blob([JSON.stringify({ schemaVersion: 1, format: "milagre-design-page", designs }, null, 2)], { type: "application/json" });
  const size = designPageExportSize(designs);
  await Promise.all(designs.map((item) => loadDesignFonts(item.document)));
  if (format === "svg") {
    const xml = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml");
    const root = xml.documentElement;
    root.setAttribute("width", String(size.width));
    root.setAttribute("height", String(size.height));
    root.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
    let left = 0;
    let bytes = 0;
    for (const [index, item] of designs.entries()) {
      const source = designSvg(item.document);
      bytes += new TextEncoder().encode(source).byteLength;
      if (bytes > 32 * 1024 * 1024) throw new Error("The page SVG exceeds the 32 MB export limit.");
      const artboard = new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
      // SVG fragment ids share a namespace even across nested SVG roots.
      const ids = new Map([...artboard.querySelectorAll("[id]")].map((element) => [element.id, `artboard${index}-${element.id}`]));
      for (const element of [artboard, ...artboard.querySelectorAll("*")]) {
        for (const attribute of [...element.attributes]) {
          let value = attribute.value.replace(/url\(#([^)]+)\)/g, (match, id) => (ids.has(id) ? `url(#${ids.get(id)})` : match));
          if (attribute.localName === "id") value = ids.get(value) ?? value;
          if (attribute.localName === "href" && value.startsWith("#")) value = `#${ids.get(value.slice(1)) ?? value.slice(1)}`;
          if (value !== attribute.value) element.setAttributeNS(attribute.namespaceURI, attribute.name, value);
        }
      }
      artboard.setAttribute("x", String(left));
      artboard.setAttribute("y", "0");
      const title = xml.createElementNS(root.namespaceURI, "title");
      title.textContent = item.title;
      artboard.prepend(title);
      root.appendChild(xml.importNode(artboard, true));
      left += item.document.width + 80;
    }
    return new Blob([new XMLSerializer().serializeToString(xml)], { type: "image/svg+xml" });
  }
  const canvas = window.document.createElement("canvas");
  canvas.width = size.pngWidth;
  canvas.height = size.pngHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This device could not create a PNG. Export the SVG or JSON instead.");
  let left = 0;
  for (const item of designs) {
    const imageUrl = URL.createObjectURL(await designExportBlob(item.document, "png", size.scale));
    try {
      const image = await loadImage(imageUrl);
      context.drawImage(image, left * size.scale, 0, item.document.width * size.scale, item.document.height * size.scale);
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
    left += item.document.width + 80;
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The page PNG could not be encoded. Export the SVG or JSON instead."))), "image/png");
  });
}
