/** Instances keep expanded layers so every renderer and export consumes the same ordinary scene tree. */
export function designInstanceRoot(document, nodeId, byId = new Map(document.nodes.map((node) => [node.id, node]))) {
  let node = byId.get(nodeId);
  for (let depth = 0; node && depth < 33; depth++) {
    if (node.componentId) return node;
    node = byId.get(node.parentId);
  }
  return null;
}

const indexChildren = (document) => {
  const children = new Map();
  for (const node of document.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  return children;
};
const descendantIds = (document, rootId, children = indexChildren(document)) => {
  const ids = new Set([rootId]);
  const pending = [rootId];
  while (pending.length) {
    for (const id of children.get(pending.pop()) ?? []) {
      if (!ids.has(id)) {
        ids.add(id);
        pending.push(id);
      }
    }
  }
  return ids;
};
const instanceChildId = (instanceId, sourceId) => {
  let hash = 2166136261;
  for (const character of sourceId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${instanceId.slice(0, 78)}-${(hash >>> 0).toString(16)}`;
};

export function synchronizeDesignComponents(document) {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const children = indexChildren(document);
  const components = new Map(document.nodes.filter((node) => node.component).map((node) => [node.id, node]));
  for (const node of document.nodes) {
    if ((node.component || node.componentId) && node.type !== "frame") throw Error("A component or instance must be a frame.");
    if (node.component && node.componentId) throw Error("An instance cannot also be a main component.");
    if (node.componentId && !components.has(node.componentId))
      throw Error(`Component "${node.componentId}" does not exist. Detach its instances before deleting it.`);
    if (node.componentId && node.componentSourceId) throw Error("An instance root cannot have a component source reference.");
    if (node.componentSourceId && !designInstanceRoot(document, node.id, byId)) throw Error("A component source reference must belong to an instance.");
  }
  for (const component of components.values()) {
    const ids = descendantIds(document, component.id, children);
    if (document.nodes.some((node) => node.id !== component.id && ids.has(node.id) && (node.component || node.componentId))) {
      throw Error("Nested components and instances are not supported inside a main component.");
    }
    if (designInstanceRoot(document, component.id, byId)) throw Error("A main component cannot live inside an instance.");
  }
  for (const instance of document.nodes.filter((node) => node.componentId)) {
    const master = components.get(instance.componentId);
    const sourceIds = descendantIds(document, master.id, children);
    const source = document.nodes.filter((node) => sourceIds.has(node.id));
    const ownedIds = descendantIds(document, instance.id, children);
    if (ownedIds.has(master.id)) throw Error("An instance cannot contain its main component.");
    const owned = document.nodes.filter((node) => ownedIds.has(node.id));
    if (owned.some((node) => node.id !== instance.id && (node.component || node.componentId))) throw Error("Nested component instances are not supported.");
    if (owned.some((node) => node.id !== instance.id && !node.componentSourceId))
      throw Error("Edit the main component or detach this instance before adding ordinary layers.");
    const ownedBySource = new Map();
    for (const node of owned) {
      if (node.id === instance.id) continue;
      if (node.componentSourceId === master.id || !sourceIds.has(node.componentSourceId))
        throw Error(`Component source "${node.componentSourceId}" does not belong to this instance's main component.`);
      if (ownedBySource.has(node.componentSourceId)) throw Error(`Component source "${node.componentSourceId}" is duplicated in this instance.`);
      ownedBySource.set(node.componentSourceId, node);
    }
    const taken = new Set(document.nodes.filter((node) => !ownedIds.has(node.id)).map((node) => node.id));
    taken.add(instance.id);
    const names = new Map([[master.id, instance.id]]);
    for (const node of source) {
      if (node.id === master.id) continue;
      const previous = ownedBySource.get(node.id);
      const preferred = previous?.id ?? instanceChildId(instance.id, node.id);
      let unique = preferred,
        suffix = 1;
      while (taken.has(unique)) unique = `${preferred}-${suffix++}`;
      names.set(node.id, unique);
      taken.add(unique);
    }
    const expanded = source.map((node) => {
      const copy = { ...node, id: names.get(node.id) };
      delete copy.component;
      delete copy.componentId;
      delete copy.componentSourceId;
      if (node.id === master.id) {
        delete copy.parentId;
        copy.componentId = master.id;
        copy.name = instance.name ?? `${master.name ?? "Component"} instance`;
        copy.x = instance.x ?? 0;
        copy.y = instance.y ?? 0;
        if (instance.parentId) copy.parentId = instance.parentId;
        delete copy.hidden;
        delete copy.locked;
        if (instance.hidden !== undefined) copy.hidden = instance.hidden;
        if (instance.locked !== undefined) copy.locked = instance.locked;
      } else {
        copy.parentId = names.get(node.parentId);
        copy.componentSourceId = node.id;
      }
      return copy;
    });
    // Preserve the instance root's position in its parent's paint order.
    const at = document.nodes.indexOf(instance);
    const insertion = document.nodes.filter((node, index) => !ownedIds.has(node.id) && index < at).length;
    document.nodes = document.nodes.filter((node) => !ownedIds.has(node.id));
    document.nodes.splice(insertion, 0, ...expanded);
  }
  if (document.nodes.length > 1000) throw Error("Expanded component instances exceed the 1000 layer limit.");
  return document;
}

export function createDesignInstance(document, componentId, instanceId, position = {}) {
  const master = document.nodes.find((node) => node.id === componentId && node.component && node.type === "frame");
  if (!master) throw Error(`Component "${componentId}" does not exist.`);
  if (document.nodes.some((node) => node.id === instanceId)) throw Error(`Layer id "${instanceId}" already exists.`);
  return [
    {
      op: "insert",
      node: {
        id: instanceId,
        type: "frame",
        componentId,
        width: master.width,
        height: master.height,
        x: position.x ?? (master.x ?? 0) + 24,
        y: position.y ?? (master.y ?? 0) + 24,
        ...(position.parentId ? { parentId: position.parentId } : {}),
        name: `${master.name ?? "Component"} instance`,
      },
    },
  ];
}

export function detachDesignInstance(document, instanceId) {
  const instance = document.nodes.find((node) => node.id === instanceId && node.componentId);
  if (!instance) throw Error("Select a linked instance to detach it.");
  const owned = descendantIds(document, instanceId);
  return [
    {
      op: "replace",
      document: {
        ...document,
        nodes: document.nodes.map((node) => {
          if (!owned.has(node.id)) return node;
          const copy = { ...node };
          delete copy.componentId;
          delete copy.componentSourceId;
          return copy;
        }),
      },
    },
  ];
}
