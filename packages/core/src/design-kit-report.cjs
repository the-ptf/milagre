async function designKitReport({ kit, chatId, chats, designs, library }) {
  const screens = [];
  for (const chat of chats) {
    const listed = await designs.list({ chatId: chat, format: "design" }).catch(() => []);
    for (const item of listed) screens.push({ chatId: chat, item });
  }
  const pages = (await library?.list({ chatId }).catch(() => null))?.pages ?? [];
  for (const page of pages) for (const item of page.designs) screens.push({ chatId, item, page: page.name });
  const report = { following: 0, frozen: [], broken: [], layout: [], local: [] };
  for (const { chatId: owner, item, page } of screens) {
    if (item.interactive || item.kit?.id !== kit.id) continue;
    const where = { id: item.id, title: item.title, ...(page ? { libraryPage: page } : { chatId: owner }) };
    if (item.kitFrozen) {
      report.frozen.push({ ...where, version: item.kit.version });
      continue;
    }
    const current = await designs.get({ chatId: owner, id: item.id }).catch((error) => ({ kitBroken: { message: error.message } }));
    if (current.kitBroken) {
      report.broken.push({ ...where, error: current.kitBroken.message });
      continue;
    }
    report.following++;
    if (current.kitFollowed?.layout?.length) report.layout.push({ ...where, warnings: current.kitFollowed.layout });
    if (current.kitFollowed?.local?.length) report.local.push({ ...where, components: current.kitFollowed.local });
  }
  return report;
}

module.exports = { designKitReport };
