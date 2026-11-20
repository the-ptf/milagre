const { execFile } = require("node:child_process");

const SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  var out = [];
  var requests = JSON.parse(argv[0]);
  for (var i = 0; i < requests.length; i++) {
    var request = requests[i];
    var image = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription(request.name, $());
    if (!image || image.isNil()) { out.push(null); continue; }
    image = image.imageWithSymbolConfiguration($.NSImageSymbolConfiguration.configurationWithPointSizeWeightScale(request.size, request.weight, 2));
    var size = image.size;
    var width = Math.ceil(size.width), height = Math.ceil(size.height);
    var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel($(), width, height, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
    image.drawInRectFromRectOperationFractionRespectFlippedHints($.NSMakeRect(0, 0, width, height), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1, false, $());
    $.NSColor.whiteColor.set;
    $.NSRectFillUsingOperation($.NSMakeRect(0, 0, width, height), $.NSCompositingOperationSourceIn);
    $.NSGraphicsContext.restoreGraphicsState;
    var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
    out.push({ width: size.width, height: size.height, png: ObjC.unwrap(png.base64EncodedStringWithOptions(0)) });
  }
  return JSON.stringify(out);
}`;
const POINT_SIZE = 96;
const BATCH = 64;
const TIMEOUT_MS = 15_000;

function runScript(requests) {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", SCRIPT, JSON.stringify(requests)],
      { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(JSON.parse(stdout));
        } catch (cause) {
          reject(cause);
        }
      },
    );
  });
}

/**
 * SF Symbols drawn by AppKit on a Mac, through osascript's JavaScript bridge (no native module). Each image is a white
 * mask the renderers tint with the layer's color; unknown symbols come back null and draw as Lucide.
 */
function createDesignHostSymbols({ platform = process.platform, run = runScript } = {}) {
  const loaded = new Map();
  const draw = async (requests) => {
    const results = [];
    for (let at = 0; at < requests.length; at += BATCH) {
      const batch = requests.slice(at, at + BATCH);
      const images = await run(batch.map(({ name, weight }) => ({ name, weight, size: POINT_SIZE }))).catch(() => batch.map(() => null));
      batch.forEach((request, index) => results.push(images[index]?.png ? { key: request.key, ...images[index] } : null));
    }
    return results;
  };
  return {
    available: platform === "darwin",
    load: async (requests) => {
      if (platform !== "darwin") return requests.map(() => null);
      const missing = requests.filter((request) => !loaded.has(request.key));
      if (missing.length) {
        const drawn = draw(missing);
        missing.forEach((request, index) =>
          loaded.set(
            request.key,
            drawn.then((images) => images[index]),
          ),
        );
      }
      return Promise.all(requests.map((request) => loaded.get(request.key)));
    },
  };
}

let hostSymbols;
/** This process's SF Symbols source, or null where the host can't draw them. */
function designHostSymbols() {
  hostSymbols ??= createDesignHostSymbols();
  return hostSymbols.available ? hostSymbols : null;
}

module.exports = { createDesignHostSymbols, designHostSymbols };
