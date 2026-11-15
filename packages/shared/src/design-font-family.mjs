export const DESIGN_DEFAULT_FONT_FAMILY = "Inter, Arial, sans-serif";

export function validDesignFontFamily(value) {
  return value.split(",").every((family) => family.trim().length > 0 && /^[\p{L}\p{N} ._-]+$/u.test(family));
}
