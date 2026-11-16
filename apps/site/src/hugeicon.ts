type IconData = [string, Record<string, string | number>][];
const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export function icon(data: unknown, size = 16, strokeWidth = 1.8) {
  const shapes = (data as IconData)
    .map(([tag, attrs]) => {
      const fields = Object.entries(attrs)
        .filter(([name]) => name !== "key")
        .map(([name, value]) => `${kebab(name)}="${name === "strokeWidth" ? strokeWidth : value}"`)
        .join(" ");
      return `<${tag} ${fields}/>`;
    })
    .join("");
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">${shapes}</svg>`;
}
