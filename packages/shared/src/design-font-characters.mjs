// The characters in the embedded Inter subsets. The font generator subsets to them and the metrics generator measures the non-ASCII ones.
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => String.fromCharCode(from + index)).join("");

/** Printable ASCII; the advance tables are arrays indexed from the space. */
export const DESIGN_ASCII_CHARACTERS = range(0x20, 0x7e);
/** Latin-1 Supplement and common typographic punctuation, measured per code point in `designFontMetrics.inter.extra`. */
export const DESIGN_EXTRA_CHARACTERS = range(0xa0, 0xff) + "‘’“”–—…•·→←↑↓€™";
