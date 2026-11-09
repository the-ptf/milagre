// Expo's defaults, plus one file read as text: Pele's browser build, which Artifact pages carry (src/pele-script.ts).
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.transformer.babelTransformerPath = require.resolve("./scripts/text-module-transformer.cjs");
module.exports = config;
