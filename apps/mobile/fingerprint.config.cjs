// The runtime version is this project's fingerprint. Build profiles (eas.json), npm scripts and the EAS project's
// account (owner, extra.eas, updates.url) don't change the native app, so they stay out of it; otherwise editing any of
// them would cut installed builds off from over-the-air updates.

/** @type {import('expo/fingerprint').Config} */
module.exports = {
  sourceSkips: ["PackageJsonScriptsAll", "ExpoConfigEASProject"],
  // Fingerprint always reads eas.json; hashing it as empty keeps the source without its content.
  fileHookTransform: (source, chunk) => (source.type === "file" && source.filePath === "eas.json" ? null : chunk),
};
