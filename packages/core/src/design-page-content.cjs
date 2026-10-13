const { validateDesignDocument, designColor } = require("@milagre/shared/design");

/** Publication is a detached snapshot. Hidden subtrees and private layer labels need not leave the Mac. */
function publicPageContent(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    title: snapshot.title,
    designs: snapshot.designs.map(({ title, document: input }) => {
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
        document: {
          schemaVersion: 1,
          width: document.width,
          height: document.height,
          ...(document.background ? { background: literal(document.background) } : {}),
          nodes: visible.map((node) => {
            const { name: _name, component: _component, componentId: _componentId, componentSourceId: _source, hidden: _hidden, ...copy } = node;
            return {
              ...copy,
              id: ids.get(node.id),
              ...(node.parentId ? { parentId: ids.get(node.parentId) } : {}),
              ...(node.fill ? { fill: literal(node.fill) } : {}),
              ...(node.stroke ? { stroke: literal(node.stroke) } : {}),
            };
          }),
        },
      };
    }),
  };
}
module.exports = { publicPageContent };
