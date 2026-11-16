const { requireWorktreeRoot } = require("@milagre/core/editors");

async function revealFolder(folder, { open, checkRoot = requireWorktreeRoot }) {
  await checkRoot(folder);
  const error = await open(folder);
  if (error) throw new Error(error);
}

module.exports = { revealFolder };
