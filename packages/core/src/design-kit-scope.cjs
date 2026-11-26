const { isLinkScopeKey, scopeFromKey, scopeKey } = require("@milagre/shared/chat-scopes");
const { designSystemMember } = require("./project-groups.cjs");

const FROZEN =
  "This Named Link's design system Project has left the Link, so its screens stay on their saved design system. Choose another member for the design system in the Link's settings.";

/** Whose design system a Chat's scope follows: a Project its own, a Named Link the member it names. */
function createDesignKitScope({ projectRegistry, scopeStates, kits }) {
  const memberPath = (group, projects) => {
    const member = designSystemMember(group);
    return (member && projects.find((project) => project.id === member)?.path) || null;
  };
  return {
    async project(key) {
      if (!isLinkScopeKey(key)) return key;
      const { projects, projectGroups } = await projectRegistry().snapshot();
      const group = projectGroups.find((item) => item.id === scopeFromKey(key).linkId);
      const project = group ? memberPath(group, projects) : null;
      if (!project) throw Object.assign(new Error(FROZEN), { code: "DESIGN_KIT_FROZEN" });
      await kits.adopt(key, project);
      return project;
    },
    /** The Project and every Named Link following its design system. */
    async followers(project) {
      const { projects, projectGroups } = await projectRegistry().snapshot();
      return [
        project,
        ...projectGroups.filter((group) => memberPath(group, projects) === project).map((group) => scopeKey({ kind: "link", linkId: group.id })),
      ];
    },
    async chats(project) {
      const chats = [];
      for (const key of await this.followers(project)) {
        if (!scopeStates().has(key)) continue;
        const sessions = (await scopeStates().get(key))?.sessions ?? {};
        chats.push(...Object.keys(sessions).map((id) => `${key}#${id}`));
      }
      return chats;
    },
  };
}

module.exports = { createDesignKitScope };
