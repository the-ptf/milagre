const BUILT_IN_CLIENT_ID = "dc64c9e039ea10991d5cd4abb3bb3633";

module.exports = {
  CLIENT_ID: process.env.MILAGRE_LINEAR_CLIENT_ID || BUILT_IN_CLIENT_ID,
  API_BASE: process.env.MILAGRE_LINEAR_API || "https://api.linear.app",
  CALLBACK_PORT: 47615,
};
