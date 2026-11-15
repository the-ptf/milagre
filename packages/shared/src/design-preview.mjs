export function designImageDocument(document, keep = (src) => src.startsWith("data:")) {
  return {
    ...document,
    nodes: document.nodes.map((node) => {
      if (node.type !== "image" || !node.src || keep(node.src)) return node;
      const { src: _src, fill: _fill, ...placeholder } = node;
      return placeholder;
    }),
  };
}

// SVG images cannot load catalog fonts: keep generic stacks and give catalog-only families a sans-serif fallback.
const generic = /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/i;
export function designPreviewDocument(document) {
  const copy = designImageDocument(document);
  let characters;
  for (let index = 0; index < copy.nodes.length; index++) {
    const node = copy.nodes[index];
    if (node.type !== "text" || !node.fontFamily || node.fontFamily.split(",").some((family) => generic.test(family.trim()))) continue;
    characters ??= JSON.stringify(copy).length;
    const suffix = ", sans-serif";
    if (node.fontFamily.length + suffix.length > 160 || characters + suffix.length > 1000000) {
      const { fontFamily: _fontFamily, ...fallback } = node;
      characters -= JSON.stringify(node).length - JSON.stringify(fallback).length;
      copy.nodes[index] = fallback;
    } else {
      characters += suffix.length;
      copy.nodes[index] = { ...node, fontFamily: node.fontFamily + suffix };
    }
  }
  return copy;
}
