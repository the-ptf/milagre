const { randomUUID } = require("node:crypto");
const { validLinkId } = require("@milagre/shared/chat-scopes");

function validProjectGroup(group) {
  return (
    group &&
    validLinkId(group.id) &&
    typeof group.name === "string" &&
    group.name.trim().length > 0 &&
    Array.isArray(group.projectIds) &&
    group.projectIds.length >= 2 &&
    group.projectIds.every((id) => typeof id === "string") &&
    new Set(group.projectIds).size === group.projectIds.length
  );
}

function membership(groups, projects, request, previous) {
  const name = typeof request?.name === "string" ? request.name.trim() : "";
  // oxlint-disable-next-line no-control-regex -- rejects control characters in a Link name
  if (!name || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new Error("Give the Link a name of 1 to 100 characters.");
  const ids = request?.projectIds;
  if (!Array.isArray(ids) || ids.length < 2 || new Set(ids).size !== ids.length) throw new Error("Choose at least two distinct Projects.");
  if (ids.some((id) => typeof id !== "string" || !(projects.some((project) => project.id === id) || previous?.projectIds.includes(id))))
    throw new Error("Open each member Project in Milagre first.");
  if (
    groups.some(
      (group) => !group.canvasLinkId && group !== previous && group.projectIds.length === ids.length && ids.every((id) => group.projectIds.includes(id)),
    )
  )
    throw new Error("A Link with these Projects already exists.");
  const hidden = typeof request?.hidden === "boolean" ? request.hidden : previous?.hidden;
  const result = { name, projectIds: [...ids], hidden: hidden === true };
  if (!result.hidden) delete result.hidden;
  const chosen = request?.designSystemProjectId;
  if (chosen !== undefined && (typeof chosen !== "string" || !ids.includes(chosen))) throw new Error("Choose a member Project for the design system.");
  const designSystem = chosen ?? (previous ? (previous.designSystemProjectId ?? previous.projectIds[0]) : undefined);
  if (designSystem && designSystem !== ids[0]) result.designSystemProjectId = designSystem;
  return result;
}

function createProjectGroup(groups, projects, request, now = () => new Date()) {
  return { id: randomUUID(), ...membership(groups, projects, request), createdAt: now().toISOString() };
}

function updateProjectGroup(groups, projects, request) {
  const previous = groups.find((group) => group.id === request?.id);
  if (!previous) throw new Error("Link no longer exists");
  if (previous.canvasLinkId) throw new Error("Manage this Link's Chat mode on the canvas.");
  const member = membership(groups, projects, request, previous);
  const updated = { ...previous, ...member };
  if (!member.hidden) delete updated.hidden;
  if (!member.designSystemProjectId) delete updated.designSystemProjectId;
  return updated;
}

/** The member whose design system the Link's Chats follow, or null while the one chosen has left the Link. */
function designSystemMember(group) {
  const id = group.designSystemProjectId ?? group.projectIds[0];
  return group.projectIds.includes(id) ? id : null;
}

function deleteProjectGroup(groups, id) {
  if (!groups.some((group) => group.id === id)) throw new Error("Link no longer exists");
  return groups.filter((group) => group.id !== id);
}

module.exports = { validProjectGroup, createProjectGroup, updateProjectGroup, deleteProjectGroup, designSystemMember };
