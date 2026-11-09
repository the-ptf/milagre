/** A Negotiation stops after this many Delegations between its two Chats. */
export const NEGOTIATION_ROUNDS = 10;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const IMAGE_ERRORS = Object.freeze({
  size: `Each image must be ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB or smaller.`,
  type: "Use PNG, JPEG, WebP, or GIF images.",
});
