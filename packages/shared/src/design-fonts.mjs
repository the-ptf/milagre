const genericFamilies = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "fangsong",
]);

export function validDesignFontFamily(value) {
  return value.split(",").every((family) => family.trim().length > 0 && /^[\p{L}\p{N} ._-]+$/u.test(family));
}

/** The document stores plain family names; quote custom names for every CSS consumer. */
export function designFontFamily(value = "Arial, sans-serif") {
  if (!validDesignFontFamily(value)) throw new Error("Use non-empty font family names separated by commas.");
  return value
    .split(",")
    .map((family) => {
      const name = family.trim();
      return genericFamilies.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`;
    })
    .join(", ");
}
