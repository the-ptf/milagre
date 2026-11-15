const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => String.fromCharCode(from + index)).join("");

export const DESIGN_ASCII_CHARACTERS = range(0x20, 0x7e);
export const DESIGN_EXTRA_CHARACTERS = range(0xa0, 0xff) + "‘’“”–—…•·→←↑↓€™";
