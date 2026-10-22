const { MAX_ATTACHMENT_BYTES, IMAGE_TYPES, IMAGE_ERRORS } = require("@milagre/shared/limits");

function decodeImages(images = []) {
  if (!Array.isArray(images)) throw new Error("Images must be an array.");
  return images.map((image) => {
    if (typeof image?.dataUrl !== "string" || image.dataUrl.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 100) throw new Error(IMAGE_ERRORS.size);
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
    if (!match || !IMAGE_TYPES.includes(match[1])) throw new Error(IMAGE_ERRORS.type);
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString("base64") !== match[2]) throw new Error("Invalid image data.");
    const mime = match[1];
    const valid =
      mime === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : mime === "image/gif"
            ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
            : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    if (!valid) throw new Error("The pasted file is not a valid supported image.");
    return { mime, bytes, base64: match[2] };
  });
}

module.exports = { decodeImages };
