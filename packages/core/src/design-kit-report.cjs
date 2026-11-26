async function designKitReport({ kit, chatId, chats, designs, library }) {
  const [listed, pages] = await Promise.all([
    Promise.all(chats.map(async (chat) => (await designs.list({ chatId: chat, format: "design" }).catch(() => [])).map((item) => ({ chatId: chat, item })))),
    library?.list({ chatId }).then(
      (value) => value.pages,
      () => [],
    ) ?? [],
  ]);
  const screens = [...listed.flat(), ...pages.flatMap((page) => page.designs.map((item) => ({ chatId, item, page: page.name })))].filter(
    ({ item }) => !item.interactive && item.kit?.id === kit.id,
  );
  const reads = await Promise.all(
    screens.map(({ chatId: owner, item }) =>
      item.kitFrozen ? null : designs.get({ chatId: owner, id: item.id }).catch((error) => ({ kitBroken: { message: error.message } })),
    ),
  );
  const report = { following: 0, frozen: [], broken: [], layout: [], local: [] };
  screens.forEach(({ chatId: owner, item, page }, index) => {
    const where = { id: item.id, title: item.title, ...(page ? { libraryPage: page } : { chatId: owner }) };
    if (item.kitFrozen) return void report.frozen.push({ ...where, version: item.kit.version });
    const current = reads[index];
    if (current.kitBroken) return void report.broken.push({ ...where, error: current.kitBroken.message });
    report.following++;
    if (current.kitFollowed?.layout?.length) report.layout.push({ ...where, warnings: current.kitFollowed.layout });
    if (current.kitFollowed?.local?.length) report.local.push({ ...where, components: current.kitFollowed.local });
  });
  return report;
}

module.exports = { designKitReport };
