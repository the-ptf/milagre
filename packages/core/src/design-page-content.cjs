const {
  validateDesignDocument,
  designColor,
  designFontSubstitute,
  designSymbolName,
  designSymbolLucide,
  designSymbolStroke,
} = require("@milagre/shared/design");

const publicIcon = (node) => {
  const name = designSymbolName(node.icon);
  if (!name) return {};
  return { icon: designSymbolLucide(name).icon, strokeWidth: node.strokeWidth ?? designSymbolStroke(node.fontWeight) };
};

const publicFamily = (fontFamily) => {
  const substitute = designFontSubstitute(fontFamily);
  if (!substitute) return fontFamily;
  const rest = fontFamily.split(",").slice(1);
  return [substitute, ...rest.filter((family) => !designFontSubstitute(family))].join(",");
};

function publicPageContent(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    ...(snapshot.kind === "workspace" ? { kind: "workspace", ...(snapshot.page ? { page: snapshot.page } : {}) } : {}),
    title: snapshot.title,
    designs: snapshot.designs.map(({ title, group, document: input, interactive }) => {
      if (interactive)
        return { title, ...(group ? { group } : {}), interactive: { html: interactive.html, width: interactive.width, height: interactive.height } };
      const document = validateDesignDocument(input);
      const byId = new Map(document.nodes.map((node) => [node.id, node]));
      const visible = document.nodes.filter((node) => {
        for (let ancestor = node; ancestor; ancestor = byId.get(ancestor.parentId)) {
          if (ancestor.hidden) return false;
        }
        return true;
      });
      const ids = new Map(visible.map((node, index) => [node.id, `layer${index + 1}`]));
      const literal = (value) => (value?.startsWith("$") ? designColor(document, value) : value);
      return {
        title,
        ...(group ? { group } : {}),
        document: {
          schemaVersion: 1,
          width: document.width,
          height: document.height,
          ...(document.background ? { background: literal(document.background) } : {}),
          nodes: visible.map((node) => {
            const {
              name: _name,
              component: _component,
              componentId: _componentId,
              componentSourceId: _source,
              hidden: _hidden,
              textStyle: _textStyle,
              bindings: _bindings,
              componentProperties: _properties,
              componentValues: _values,
              ...copy
            } = node;
            return {
              ...copy,
              id: ids.get(node.id),
              ...(node.parentId ? { parentId: ids.get(node.parentId) } : {}),
              ...(node.fill ? { fill: literal(node.fill) } : {}),
              ...(node.stroke ? { stroke: literal(node.stroke) } : {}),
              ...(node.fontFamily ? { fontFamily: publicFamily(node.fontFamily) } : {}),
              ...publicIcon(node),
            };
          }),
        },
      };
    }),
  };
}
module.exports = { publicPageContent };
