const MAX_SCREENS = 20;

const localComponents = (document) => document.nodes.filter((node) => node.component && !Object.hasOwn(document.kit?.components ?? {}, node.id));
const componentKey = (node) => (node.name ?? node.id).trim().toLowerCase();

async function repeatedComponents({ api, chatId, id, document }) {
  const own = localComponents(document);
  if (!own.length) return [];
  const others = (await api.list({ chatId, format: "design" }).catch(() => [])).filter((item) => item.id !== id && !item.interactive).slice(0, MAX_SCREENS);
  const found = new Map();
  for (const other of others) {
    const read = await api.get({ chatId, id: other.id, format: "design" }).catch(() => null);
    if (!read?.document) continue;
    const keys = new Set(localComponents(read.document).map(componentKey));
    for (const node of own) if (keys.has(componentKey(node))) found.set(node.id, [...(found.get(node.id) ?? []), `"${other.title}"`]);
  }
  return [...found].map(([component, screens]) => `"${component}" (also on ${screens.join(", ")})`);
}

/** What the agent should offer to move into the Project's design system after saving `document`. */
async function designSystemNotes({ api, chatId, id, document, warnings }) {
  const notes = [];
  const drift = warnings.filter((warning) => warning.kind === "kit-drift").length;
  if (drift)
    notes.push(
      `${drift} value(s) here are outside the design system. Use its tokens, unless the user asked for these values: if they should hold on every screen, propose them as a design system change and save it with design_kit_save only after the user agrees; if only for this screen, keep them and say so.`,
    );
  const repeated = await repeatedComponents({ api, chatId, id, document });
  if (repeated.length)
    notes.push(
      `Local component ${repeated.join(", ")}: the same piece on two screens belongs in the design system. Propose adding it to the kit's components; after the user agrees, save it with design_kit_save and the screens follow it.`,
    );
  return notes;
}

module.exports = { designSystemNotes };
