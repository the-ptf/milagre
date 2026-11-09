// Prints desktop's chip icons as SVG strings for build-chip-glyphs.py, keyed by the character that draws each one.
const icons = require("@hugeicons/core-free-icons");

const attr = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const svg = (icon) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${icon
    .map(
      ([tag, props]) =>
        `<${tag} ${Object.entries(props)
          .filter(([name]) => name !== "key")
          .map(([name, value]) => `${attr(name)}="${value === "currentColor" ? "#000" : value}"`)
          .join(" ")}/>`,
    )
    .join("")}</svg>`;

process.stdout.write(JSON.stringify({ "[": svg(icons.Image01Icon), "/": svg(icons.MagicWand01Icon), "@": svg(icons.File01Icon) }));
