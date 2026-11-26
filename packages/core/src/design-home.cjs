const { chatTitle } = require("@milagre/shared/chats");
const { withDesignHost } = require("./design-host-fonts.cjs");
const design = () => withDesignHost(require("@milagre/shared/design"));

/**
 * The reads behind a Project's Designs page: its design system drawn as one board with its decision log, and the
 * designs of every Chat of the Project (a Named Link's own Chats for a Link). `scope` turns a request's `{chatId}` or
 * `{projectPath}` into the Project or Link key.
 */
function createDesignHome({ scope, kitScope, kits, designs, scopeStates }) {
  return {
    async system(request) {
      const key = await scope(request);
      let project;
      try {
        project = await kitScope.project(key);
      } catch (error) {
        if (error.code === "DESIGN_KIT_FROZEN") return { state: "frozen" };
        throw error;
      }
      const [kit, history] = await Promise.all([kits.readProject({ project }), kits.history({ project })]);
      const owner = project === key ? undefined : project;
      if (!kit) return { state: "none", ...(owner ? { owner } : {}) };
      const board = design().validateDesignDocument(design().designSystemBoard(kit, { subtitle: `Version ${kit.version}` }));
      return {
        state: "ready",
        kit: { id: kit.id, version: kit.version, title: kit.title },
        history: history.toReversed(),
        svg: design().designSvg(board, { embedFonts: false }),
        width: board.width,
        height: board.height,
        ...(owner ? { owner } : {}),
      };
    },
    async chats(request) {
      const key = await scope(request);
      const sessions = Object.entries((await scopeStates().get(key))?.sessions ?? {});
      const chats = await Promise.all(
        sessions.map(async ([id, session]) => {
          const chatId = `${key}#${id}`;
          const listed = await designs.list({ chatId, format: "design" }).catch(() => []);
          return { id: Number(id), chatId, title: chatTitle(session), archived: session.archived === true, designs: listed };
        }),
      );
      return chats
        .filter((chat) => chat.designs.length)
        .toSorted((a, b) => Number(a.archived) - Number(b.archived) || b.id - a.id)
        .map(({ id: _id, ...chat }) => chat);
    },
  };
}

module.exports = { createDesignHome };
