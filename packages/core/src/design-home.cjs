const { chatTitle } = require("@milagre/shared/chats");
const { projectOfKey } = require("@milagre/shared/agent-runs");
const { withDesignHost } = require("./design-host-fonts.cjs");
const design = () => withDesignHost(require("@milagre/shared/design"));

/**
 * The reads behind a Project's Designs page: its design system drawn as one board with its decision log, and the
 * designs of every Chat of the Project (a Named Link's own Chats for a Link).
 */
function createDesignHome({ existingChat, kitScope, kits, designs, scopeStates }) {
  /** The one Project or Link a request names, by a Chat of it or by its path; a request naming both is refused. */
  async function scope(request) {
    if (request?.chatId !== undefined && request?.projectPath !== undefined) throw new Error("Send chatId or projectPath, not both.");
    if (typeof request?.chatId === "string") {
      await existingChat(request.chatId);
      return projectOfKey(request.chatId);
    }
    if (typeof request?.projectPath !== "string" || !scopeStates().has(request.projectPath)) throw new Error("Open this project in Milagre first.");
    return request.projectPath;
  }
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
      return {
        state: "ready",
        kit: { id: kit.id, version: kit.version, title: kit.title },
        history: history.toReversed(),
        boards: design()
          .designSystemBoards(kit, { subtitle: `Version ${kit.version}` })
          .map((board) => ({ svg: design().designSvg(board, { embedFonts: false }), width: board.width, height: board.height })),
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
